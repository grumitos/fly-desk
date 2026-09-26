/*
 * Search admission: which searches run now, and in what order the rest wait.
 *
 * Every search costs capacity units by what it makes the search unit (the
 * runner and its pooled workers) and the providers carry, measured against
 * the E2E fakes at 470 fares a day (Agil 50 per GDS, Click and Book Plus 120):
 *
 * - an exact search, 1: nine provider requests, eight in flight, a fraction of
 *   a second of runner CPU and about 20 MiB;
 * - a flexible round-trip matrix, 2: it fills the Agil in-flight ceiling (32)
 *   for a few seconds, but keeps one fare a cell and barely moves memory;
 * - a range of up to ten days, 2: nine requests a day, three days at a time; a
 *   seven-day range took the runner about 120 MiB above rest at its peak;
 * - a range of up to a month, 3: a migratory sweep's month is one, and the unit
 *   went from about 190 MiB at rest to about 770 MiB as a month of fares
 *   completed;
 * - a longer range, everything heavy work may hold: it runs beside nothing
 *   heavier than an exact search.
 *
 * The budget is 7 units, 2 of them reserved for exact searches: heavy work
 * (anything but an exact search) holds at most 5. That runs a sweep's month
 * beside another agent's short range or matrix, never two months at once —
 * which took the unit past 1.3 GiB against its `MemoryHigh=900M` — and lets
 * each of the two agents start an exact search at any moment, whatever runs.
 *
 * Units are an estimate, so memory has the last word where it can be read
 * (`unit-memory.ts`): a heavy search starts beside other heavy work only while
 * the unit's memory — what it holds now, or what the heavy searches running
 * are expected to reach, whichever is more — leaves room under 90% of its
 * limit for what this one is expected to add. A heavy search alone always
 * starts, so the wait is never longer than the heavy work already running.
 *
 * Nothing is refused for capacity: a search that does not fit waits, and
 * leaves the queue only when its job is stopped (see `http-router.ts`, which
 * also stops a job nobody follows any more).
 *
 * Order: exact searches start first-come, first-served, and past their
 * reserve only while no heavy search waits, so they never hold one back.
 * Heavy searches start fairest session first — the session holding the fewest
 * heavy units, then the one served longest ago — and each session's own
 * searches keep their order. A heavy search that does not fit yet is not
 * overtaken by another heavy one, so the largest search is never starved.
 */

import { createUnitMemoryGauge, type UnitMemoryGauge } from "./unit-memory";

export type SearchAdmissionKind = "exact" | "range" | "matrix";

const CAPACITY_UNITS = 7;
const EXACT_RESERVED_UNITS = 2;
const HEAVY_LIMIT_UNITS = CAPACITY_UNITS - EXACT_RESERVED_UNITS;
const EXACT_COST_UNITS = 1;
const MATRIX_COST_UNITS = 2;
const SHORT_RANGE_COST_UNITS = 2;
const MONTH_RANGE_COST_UNITS = 3;
/* A range asks one exact search a day: these many days or fewer are a short
   range, and a month is up to 31 of them. */
const SHORT_RANGE_MAX_DAY_SEARCHES = 10;
const MONTH_RANGE_MAX_DAY_SEARCHES = 31;
/* Who asked, when nobody signed in did: the API token or a trusted loopback. */
const UNSIGNED_SESSION_KEY = "unsigned";

const MIB = 1024 * 1024;
/* What a heavy search adds to the unit's memory at its peak: about 20 MiB a
   day of a range (a month, from 190 to 770 MiB), and 60 MiB for a matrix. */
const RANGE_DAY_PEAK_BYTES = 20 * MIB;
const MATRIX_PEAK_BYTES = 60 * MIB;
const HEAVY_MEMORY_SHARE = 0.9;
/* Memory frees without telling anyone: a heavy search held back by it is
   looked at again this often. */
const MEMORY_RECHECK_MS = 1_000;

export interface SearchAdmissionRequest {
  kind: SearchAdmissionKind;
  /** A range's exact searches, one a day: what its cost grows with. */
  daySearches?: number;
  jobId?: string;
  /** Who asked: one signed-in browser, or the unsigned callers. Fairness is per session. */
  sessionKey?: string;
  /** The job's own stop: a search stopped while it waits leaves the queue at once. */
  signal?: AbortSignal;
  /** Called before `acquire` returns when the search has to wait, and only then. */
  onQueued?: () => void;
}

export interface SearchAdmissionLease {
  costUnits: number;
  queuedMs: number;
  /** Frees the units; later calls do nothing. */
  release: () => void;
}

/** What the desk draws: occupancy of the shared capacity, and a version to wait on. */
export interface SearchCapacitySnapshot {
  version: string;
  capacityUnits: number;
  activeUnits: number;
  queuedUnits: number;
  activeSearches: number;
  queuedSearches: number;
}

interface SearchAdmissionDiagnostics extends Omit<SearchCapacitySnapshot, "version"> {
  exactReservedUnits: number;
  /** The unit's anonymous memory against its limit, where it can be read. */
  memory?: { usedBytes: number; limitBytes: number };
  active: Array<{ kind: SearchAdmissionKind; jobId?: string; costUnits: number; activeMs: number }>;
  queued: Array<{ kind: SearchAdmissionKind; jobId?: string; costUnits: number; queuedMs: number }>;
}

interface ActiveEntry {
  kind: SearchAdmissionKind;
  jobId?: string;
  sessionKey: string;
  costUnits: number;
  peakBytes: number;
  heavy: boolean;
  startedAtMs: number;
}

interface QueuedEntry {
  kind: SearchAdmissionKind;
  jobId?: string;
  sessionKey: string;
  costUnits: number;
  peakBytes: number;
  heavy: boolean;
  enqueuedAtMs: number;
  admit: () => void;
  turnAway: (message: string) => void;
}

/* The search will not start: its job was stopped while it waited, or the
   runner is shutting down. */
export class SearchAdmissionError extends Error {
  override name = "SearchAdmissionError";
}

export function searchCostUnits(kind: SearchAdmissionKind, daySearches = 1): number {
  switch (kind) {
    case "exact":
      return EXACT_COST_UNITS;
    case "matrix":
      return MATRIX_COST_UNITS;
    case "range":
      if (daySearches <= SHORT_RANGE_MAX_DAY_SEARCHES) {
        return SHORT_RANGE_COST_UNITS;
      }
      return daySearches <= MONTH_RANGE_MAX_DAY_SEARCHES ? MONTH_RANGE_COST_UNITS : HEAVY_LIMIT_UNITS;
  }
}

function searchPeakBytes(kind: SearchAdmissionKind, daySearches = 1): number {
  switch (kind) {
    case "exact":
      return 0;
    case "matrix":
      return MATRIX_PEAK_BYTES;
    case "range":
      return daySearches * RANGE_DAY_PEAK_BYTES;
  }
}

function unitsOf(entries: Iterable<{ costUnits: number }>): number {
  let units = 0;
  for (const entry of entries) {
    units += entry.costUnits;
  }
  return units;
}

export class SearchAdmissionController {
  private readonly memory: UnitMemoryGauge;
  private memoryRecheck: ReturnType<typeof setTimeout> | undefined;
  private readonly active = new Map<symbol, ActiveEntry>();
  /* In arrival order; `pickNext` decides who leaves it. */
  private readonly queued: QueuedEntry[] = [];
  /* When each session last had a heavy search admitted, while it has work here. */
  private readonly lastHeavyAdmission = new Map<string, number>();
  private heavyAdmissions = 0;
  private readonly boot = crypto.randomUUID().slice(0, 8);
  private revision = 0;
  private readonly changeWaiters = new Set<() => void>();
  private stoppingMessage: string | undefined;

  constructor(memory: UnitMemoryGauge = createUnitMemoryGauge()) {
    this.memory = memory;
  }

  acquire(request: SearchAdmissionRequest): Promise<SearchAdmissionLease> {
    if (this.stoppingMessage !== undefined) {
      return Promise.reject(new SearchAdmissionError(this.stoppingMessage));
    }
    if (request.signal?.aborted) {
      return Promise.reject(new SearchAdmissionError("Search was stopped before it started."));
    }

    const enqueuedAtMs = Date.now();
    const costUnits = searchCostUnits(request.kind, request.daySearches);
    const sessionKey = request.sessionKey || UNSIGNED_SESSION_KEY;
    return new Promise((resolve, reject) => {
      const leave = () => {
        if (this.removeQueued(entry)) {
          reject(new SearchAdmissionError("Search was stopped before it started."));
        }
      };
      const entry: QueuedEntry = {
        kind: request.kind,
        jobId: request.jobId,
        sessionKey,
        costUnits,
        peakBytes: searchPeakBytes(request.kind, request.daySearches),
        heavy: request.kind !== "exact",
        enqueuedAtMs,
        admit: () => {
          request.signal?.removeEventListener("abort", leave);
          resolve(this.start(entry));
        },
        turnAway: (message) => {
          request.signal?.removeEventListener("abort", leave);
          reject(new SearchAdmissionError(message));
        },
      };
      this.queued.push(entry);
      this.startQueued();
      if (this.queued.includes(entry)) {
        request.signal?.addEventListener("abort", leave, { once: true });
        request.onQueued?.();
        this.changed();
      }
    });
  }

  /** No search starts from now on; the waiting ones are turned away with `message`. */
  stopAccepting(message: string): void {
    this.stoppingMessage = message;
    clearTimeout(this.memoryRecheck);
    const turnedAway = this.queued.splice(0);
    if (turnedAway.length > 0) {
      this.forgetIdleSessions();
      this.changed();
    }
    for (const entry of turnedAway) {
      entry.turnAway(message);
    }
  }

  /** Resolves `true` once nothing runs, or `false` after `timeoutMs`. */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.active.size > 0 && Date.now() < deadline) {
      await this.waitForChange(this.snapshot().version, deadline - Date.now());
    }
    return this.active.size === 0;
  }

  snapshot(): SearchCapacitySnapshot {
    return {
      version: `${this.boot}-${this.revision}`,
      capacityUnits: CAPACITY_UNITS,
      activeUnits: unitsOf(this.active.values()),
      queuedUnits: unitsOf(this.queued),
      activeSearches: this.active.size,
      queuedSearches: this.queued.length,
    };
  }

  /*
   * Resolves once the snapshot is no longer `version`, after `timeoutMs`, or
   * when `signal` aborts. At once when it already differs, which is what a
   * caller that has never seen one, or has seen the runner restart, gets.
   */
  waitForChange(version: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (!version || version !== this.snapshot().version || timeoutMs <= 0 || signal?.aborted) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", settle);
        this.changeWaiters.delete(settle);
        resolve();
      };
      const timer = setTimeout(settle, timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", settle, { once: true });
      this.changeWaiters.add(settle);
    });
  }

  getDiagnostics(nowMs = Date.now()): SearchAdmissionDiagnostics {
    const { version: _version, ...snapshot } = this.snapshot();
    return {
      ...snapshot,
      exactReservedUnits: EXACT_RESERVED_UNITS,
      memory: this.memory(),
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

  /*
   * The next search to start out of `queued`, or none. An exact search goes
   * first whenever it fits: within its reserve always, past it only while no
   * heavy search waits. Then the fairest session's oldest heavy search, if it
   * fits in the units and, beside other heavy work, in memory; if it does not,
   * no heavy search starts.
   */
  private pickNext(): QueuedEntry | undefined {
    const active = [...this.active.values()];
    const totalUnits = unitsOf(active);
    const exactUnits = unitsOf(active.filter((entry) => !entry.heavy));
    const heavyUnits = totalUnits - exactUnits;
    const heavyWaiting = this.queued.some((entry) => entry.heavy);

    const exact = this.queued.find((entry) => !entry.heavy);
    if (
      exact
      && totalUnits + exact.costUnits <= CAPACITY_UNITS
      && (!heavyWaiting || exactUnits + exact.costUnits <= EXACT_RESERVED_UNITS)
    ) {
      return exact;
    }

    const heavyUnitsBySession = new Map<string, number>();
    for (const entry of active) {
      if (entry.heavy) {
        heavyUnitsBySession.set(entry.sessionKey, (heavyUnitsBySession.get(entry.sessionKey) ?? 0) + entry.costUnits);
      }
    }
    let fairest: QueuedEntry | undefined;
    const seenSessions = new Set<string>();
    for (const entry of this.queued) {
      if (!entry.heavy || seenSessions.has(entry.sessionKey)) {
        continue;
      }
      seenSessions.add(entry.sessionKey);
      if (!fairest || this.isFairer(entry, fairest, heavyUnitsBySession)) {
        fairest = entry;
      }
    }

    if (!fairest || heavyUnits + fairest.costUnits > HEAVY_LIMIT_UNITS) {
      return undefined;
    }
    if (heavyUnits > 0 && !this.memoryAllows(fairest, active)) {
      this.recheckMemoryLater();
      return undefined;
    }
    return fairest;
  }

  private memoryAllows(entry: QueuedEntry, active: readonly ActiveEntry[]): boolean {
    const reading = this.memory();
    if (!reading) {
      return true;
    }

    const expected = active.reduce((total, running) => total + (running.heavy ? running.peakBytes : 0), 0);
    return Math.max(reading.usedBytes, expected) + entry.peakBytes <= HEAVY_MEMORY_SHARE * reading.limitBytes;
  }

  private recheckMemoryLater(): void {
    if (this.memoryRecheck) {
      return;
    }
    this.memoryRecheck = setTimeout(() => {
      this.memoryRecheck = undefined;
      this.startQueued();
    }, MEMORY_RECHECK_MS);
    this.memoryRecheck.unref?.();
  }

  private isFairer(candidate: QueuedEntry, current: QueuedEntry, heavyUnitsBySession: ReadonlyMap<string, number>): boolean {
    const held = (heavyUnitsBySession.get(candidate.sessionKey) ?? 0) - (heavyUnitsBySession.get(current.sessionKey) ?? 0);
    if (held !== 0) {
      return held < 0;
    }
    const served = (this.lastHeavyAdmission.get(candidate.sessionKey) ?? -1) - (this.lastHeavyAdmission.get(current.sessionKey) ?? -1);
    return served !== 0 ? served < 0 : candidate.enqueuedAtMs < current.enqueuedAtMs;
  }

  private start(entry: QueuedEntry): SearchAdmissionLease {
    const id = Symbol("active-search");
    const startedAtMs = Date.now();
    this.active.set(id, {
      kind: entry.kind,
      jobId: entry.jobId,
      sessionKey: entry.sessionKey,
      costUnits: entry.costUnits,
      peakBytes: entry.peakBytes,
      heavy: entry.heavy,
      startedAtMs,
    });
    if (entry.heavy) {
      this.heavyAdmissions += 1;
      this.lastHeavyAdmission.set(entry.sessionKey, this.heavyAdmissions);
    }
    let released = false;

    return {
      costUnits: entry.costUnits,
      queuedMs: Math.max(0, startedAtMs - entry.enqueuedAtMs),
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.active.delete(id);
        this.forgetIdleSessions();
        this.changed();
        this.startQueued();
      },
    };
  }

  private startQueued(): void {
    if (this.stoppingMessage !== undefined) {
      return;
    }

    let started = false;
    for (let next = this.pickNext(); next; next = this.pickNext()) {
      this.queued.splice(this.queued.indexOf(next), 1);
      next.admit();
      started = true;
    }
    if (started) {
      this.changed();
    }
  }

  private removeQueued(entry: QueuedEntry): boolean {
    const index = this.queued.indexOf(entry);
    if (index < 0) {
      return false;
    }

    this.queued.splice(index, 1);
    this.forgetIdleSessions();
    this.changed();
    /* Whoever it held back by waiting (an exact search past its reserve, a
       heavy one behind it) may start now. */
    this.startQueued();
    return true;
  }

  /* A session with nothing running or waiting is the least recently served
     when it comes back; forgetting it keeps the map to the sessions at work. */
  private forgetIdleSessions(): void {
    const working = new Set<string>();
    for (const entry of this.active.values()) {
      working.add(entry.sessionKey);
    }
    for (const entry of this.queued) {
      working.add(entry.sessionKey);
    }
    for (const sessionKey of [...this.lastHeavyAdmission.keys()]) {
      if (!working.has(sessionKey)) {
        this.lastHeavyAdmission.delete(sessionKey);
      }
    }
  }

  private changed(): void {
    this.revision += 1;
    for (const settle of [...this.changeWaiters]) {
      settle();
    }
  }
}
