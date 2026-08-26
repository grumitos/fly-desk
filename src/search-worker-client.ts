import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  CanonicalOffer,
  MatrixCell,
  MatrixResponse,
  ProviderDiagnosticEvent,
  ProviderContext,
  ProviderId,
  SearchRequest,
} from "./core/types";
import type {
  ProviderSearchWorkerInbound,
  ProviderSearchWorkerMessage,
  ProviderSearchWorkerRequest,
} from "./search-worker-protocol";

export interface ProviderSearchResult {
  offers: CanonicalOffer[];
  warnings: string[];
  partial: boolean;
  incremental?: boolean;
}

export interface ProviderSearchWorkerInput {
  kind: "exact" | "range";
  providerId: ProviderId;
  request: SearchRequest;
  providerContext?: ProviderContext;
  onProgress?: (result: ProviderSearchResult) => boolean | void;
  onProviderEvent?: (event: ProviderDiagnosticEvent) => void;
  shouldContinue?: () => boolean;
}

export interface ProviderMatrixWorkerInput {
  providerId: ProviderId;
  request: SearchRequest;
  providerContext?: ProviderContext;
  draft: MatrixResponse;
  onCellResolved?: (cell: MatrixCell) => boolean | void;
  onProviderEvent?: (event: ProviderDiagnosticEvent) => void;
  shouldContinue?: () => boolean;
}

interface WorkerHandle {
  kill: () => void;
}

const POOLED_PROVIDER_IDS = ["agil-local", "costamar"] as const satisfies readonly ProviderId[];
const DEFAULT_SEARCH_WORKER_MAX_JOBS = 500;
const CANCELLATION_POLL_INTERVAL_MS = 500;

function searchWorkerProcessesEnabled(): boolean {
  return process.env.FLY_DESK_SEARCH_WORKER_PROCESSES !== "0";
}

/* The pool is the default path; `0` restores the spawn-per-search behaviour,
   which stays in `runInWorker` untouched so it remains a working escape hatch. */
export function searchWorkerPoolEnabled(): boolean {
  return searchWorkerProcessesEnabled()
    && String(process.env.FLY_DESK_SEARCH_WORKER_POOL ?? "1").trim() !== "0";
}

function searchWorkerMaxJobs(): number {
  const raw = Number(process.env.FLY_DESK_SEARCH_WORKER_MAX_JOBS ?? DEFAULT_SEARCH_WORKER_MAX_JOBS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_SEARCH_WORKER_MAX_JOBS;
}

function resolveWorkerPath(): string | undefined {
  const workerPath = join(process.cwd(), "src", "search-worker.ts");
  return existsSync(workerPath) ? workerPath : undefined;
}

interface BunExecutableResolverOptions {
  env?: Record<string, string | undefined>;
  execPath?: string;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}

function normalizeExecutableCandidate(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim() || undefined;
  }

  return trimmed;
}

function isLikelyBunExecutable(value: string): boolean {
  const fileName = value.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  return fileName === "bun" || fileName === "bun.exe";
}

function resolveBunExecutable(options: BunExecutableResolverOptions = {}): string {
  const env = options.env ?? process.env;
  const execPath = normalizeExecutableCandidate(options.execPath ?? process.execPath);
  const platform = options.platform ?? process.platform;
  const pathExists = options.exists ?? existsSync;
  const executableName = platform === "win32" ? "bun.exe" : "bun";
  const explicitExecutable = normalizeExecutableCandidate(env.BUN_EXECUTABLE_PATH);
  if (explicitExecutable) {
    return explicitExecutable;
  }

  if (execPath && isLikelyBunExecutable(execPath)) {
    return execPath;
  }

  const bunInstall = normalizeExecutableCandidate(env.BUN_INSTALL);
  const candidates = [
    bunInstall ? join(bunInstall, "bin", executableName) : undefined,
    env.USERPROFILE ? join(env.USERPROFILE, ".bun", "bin", "bun.exe") : undefined,
    env.HOME ? join(env.HOME, ".bun", "bin", executableName) : undefined,
  ];

  return candidates.find((candidate) => candidate && pathExists(candidate)) ?? "bun";
}

export function resolveSearchWorkerBunExecutableForTests(options: BunExecutableResolverOptions): string {
  return resolveBunExecutable(options);
}

export function searchWorkerPathAvailable(): boolean {
  return resolveWorkerPath() !== undefined;
}

function rejectWithWorkerError(message: Extract<ProviderSearchWorkerMessage, { type: "error" }>): Error {
  const error = new Error(message.message);
  error.name = message.name || "ProviderSearchWorkerError";
  if (message.stack) {
    error.stack = message.stack;
  }
  return error;
}

function parseWorkerMessage(line: string): ProviderSearchWorkerMessage | undefined {
  try {
    return JSON.parse(line) as ProviderSearchWorkerMessage;
  } catch {
    return undefined;
  }
}

async function readJsonLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        onLine(line);
      }
    }
  }

  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) {
    onLine(tail);
  }
}

function runInWorker(
  input: ProviderSearchWorkerRequest,
  onMessage: (message: ProviderSearchWorkerMessage, child: WorkerHandle) => void,
  shouldContinue?: () => boolean,
): Promise<ProviderSearchWorkerMessage> {
  const workerPath = resolveWorkerPath();
  if (!searchWorkerProcessesEnabled() || !workerPath) {
    return Promise.reject(new Error("Search worker processes are disabled or unavailable."));
  }

  return new Promise((resolve, reject) => {
    const bunExecutable = resolveBunExecutable();
    const child = Bun.spawn([bunExecutable, workerPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BUN_EXECUTABLE_PATH: bunExecutable,
        FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS: "1",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let settled = false;
    let cancellationTimer: ReturnType<typeof setInterval> | undefined;

    const handle: WorkerHandle = {
      kill: () => {
        child.kill();
      },
    };

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (cancellationTimer) {
        clearInterval(cancellationTimer);
      }
      callback();
      child.kill();
    };

    if (shouldContinue) {
      cancellationTimer = setInterval(() => {
        let keepGoing = false;
        try {
          keepGoing = shouldContinue();
        } catch {
          keepGoing = false;
        }

        if (!keepGoing) {
          finish(() => reject(new Error("Search worker cancelled.")));
        }
      }, 500);
      cancellationTimer.unref?.();
    }

    const stderrPromise = new Response(child.stderr).text();
    const stdoutDrained = readJsonLines(child.stdout, (line) => {
      const message = parseWorkerMessage(line);
      if (!message || message.id !== input.id) {
        return;
      }

      onMessage(message, handle);
      if (message.type === "search-complete" || message.type === "matrix-complete") {
        finish(() => resolve(message));
      } else if (message.type === "error") {
        finish(() => reject(rejectWithWorkerError(message)));
      }
    }).catch((error) => {
      finish(() => reject(error));
    });

    void Promise.resolve(child.exited).then(async (code) => {
      /* A worker writes its answer to stdout and then exits, and those are two
         events this process can observe in either order. On a loaded machine
         the exit arrives first often enough to matter, and answering it
         immediately reports "the worker stopped" over a provider error the
         worker had already sent — which is how the reason a search failed gets
         replaced by the fact that it did. Reading what is left first costs
         nothing: this path only runs when the process is already gone. */
      await stdoutDrained;
      if (settled) {
        return;
      }

      const hadDiagnostics = Boolean((await stderrPromise).trim());
      finish(() => reject(new Error(
        `Search worker stopped before completing (exit code ${code ?? "unknown"}).${hadDiagnostics ? " Worker diagnostics were emitted." : ""}`,
      )));
    }).catch((error: unknown) => {
      finish(() => reject(error));
    });

    Promise.resolve(child.stdin.write(new TextEncoder().encode(`${JSON.stringify(input)}\n`)))
      .then(() => child.stdin.end())
      .catch((error: unknown) => {
        finish(() => reject(error));
      });
  });
}

/* ---------------------------------------------------------------------------
 * Persistent worker pool
 *
 * One long-lived worker per provider, multiplexing jobs by id over the same
 * stdin/stdout. The point is the module caches inside the worker — the Agil
 * bearer, the Costamar engine metadata, the TLS connections — which a fresh
 * process per search throws away every time.
 * ------------------------------------------------------------------------ */

export interface SearchWorkerChildStdin {
  write: (chunk: Uint8Array) => unknown;
  end: () => unknown;
  flush?: () => unknown;
}

export interface SearchWorkerChild {
  readonly pid?: number;
  readonly stdin: SearchWorkerChildStdin;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number | null>;
  kill: () => void;
}

export type SearchWorkerSpawn = (providerId: ProviderId) => SearchWorkerChild;

export interface SearchWorkerPool {
  run: (
    input: ProviderSearchWorkerRequest,
    onMessage: (message: ProviderSearchWorkerMessage, child: WorkerHandle) => void,
    shouldContinue?: () => boolean,
  ) => Promise<ProviderSearchWorkerMessage>;
  prewarm: (providerId: ProviderId) => Promise<void>;
  start: () => void;
  stop: () => void;
  workerPidForTests: (providerId: ProviderId) => number | undefined;
}

interface PooledJob {
  id: string;
  settled: boolean;
  onMessage: (message: ProviderSearchWorkerMessage) => void;
  resolve: (message: ProviderSearchWorkerMessage) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setInterval>;
}

interface PooledWorker {
  providerId: ProviderId;
  child: SearchWorkerChild;
  jobs: Map<string, PooledJob>;
  completedJobs: number;
  retiring: boolean;
  stderr: Promise<string>;
}

interface SearchWorkerPoolOptions {
  spawn: SearchWorkerSpawn;
  maxJobs?: number;
}

function createSearchWorkerPool(options: SearchWorkerPoolOptions): SearchWorkerPool {
  const workers = new Map<ProviderId, PooledWorker>();
  const resolveMaxJobs = (): number => options.maxJobs ?? searchWorkerMaxJobs();

  const writeToWorker = (worker: PooledWorker, message: ProviderSearchWorkerInbound): void => {
    worker.child.stdin.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
    worker.child.stdin.flush?.();
  };

  /* Retire only when idle: ending stdin lets the worker exit on its own, and a
     worker still holding jobs would take them down with it. */
  const maybeRecycle = (worker: PooledWorker): void => {
    if (worker.retiring || worker.jobs.size > 0 || worker.completedJobs < resolveMaxJobs()) {
      return;
    }

    worker.retiring = true;
    if (workers.get(worker.providerId) === worker) {
      workers.delete(worker.providerId);
    }
    try {
      worker.child.stdin.end();
    } catch {
      worker.child.kill();
    }
  };

  const settleJob = (worker: PooledWorker, job: PooledJob, complete: () => void): void => {
    if (job.settled) {
      return;
    }

    job.settled = true;
    if (job.timer) {
      clearInterval(job.timer);
    }
    worker.jobs.delete(job.id);
    worker.completedJobs += 1;
    complete();
    maybeRecycle(worker);
  };

  const cancelJob = (worker: PooledWorker, job: PooledJob): void => {
    if (job.settled) {
      return;
    }

    if (!worker.retiring) {
      try {
        writeToWorker(worker, { id: job.id, type: "cancel" });
      } catch {
        /* A worker that cannot take the cancel is already gone; the rejection
           below is what the caller needs either way. */
      }
    }
    settleJob(worker, job, () => job.reject(new Error("Search worker cancelled.")));
  };

  const deliver = (worker: PooledWorker, job: PooledJob, message: ProviderSearchWorkerMessage): void => {
    if (message.type === "error") {
      settleJob(worker, job, () => job.reject(rejectWithWorkerError(message)));
      return;
    }

    if (
      message.type === "search-complete"
      || message.type === "matrix-complete"
      || message.type === "prewarm-complete"
    ) {
      settleJob(worker, job, () => job.resolve(message));
      return;
    }

    job.onMessage(message);
  };

  const ensureWorker = (providerId: ProviderId): PooledWorker => {
    const existing = workers.get(providerId);
    if (existing && !existing.retiring) {
      return existing;
    }

    const child = options.spawn(providerId);
    const worker: PooledWorker = {
      providerId,
      child,
      jobs: new Map(),
      completedJobs: 0,
      retiring: false,
      stderr: new Response(child.stderr).text().catch(() => ""),
    };
    workers.set(providerId, worker);

    const stdoutDrained = readJsonLines(child.stdout, (line) => {
      const message = parseWorkerMessage(line);
      if (!message) {
        return;
      }

      const job = worker.jobs.get(message.id);
      if (!job) {
        return;
      }

      deliver(worker, job, message);
    }).catch(() => undefined);

    void Promise.resolve(child.exited).then(async (code) => {
      if (workers.get(providerId) === worker) {
        workers.delete(providerId);
      }

      /* Same order-of-arrival as the spawn-per-search path above: what the
         pool has left to read decides which of these jobs are still pending. */
      await stdoutDrained;
      const pending = [...worker.jobs.values()];
      if (pending.length === 0) {
        return;
      }

      const hadDiagnostics = Boolean((await worker.stderr).trim());
      const error = new Error(
        `Search worker stopped before completing (exit code ${code ?? "unknown"}).${hadDiagnostics ? " Worker diagnostics were emitted." : ""}`,
      );
      pending.forEach((job) => {
        settleJob(worker, job, () => job.reject(error));
      });
    }).catch(() => undefined);

    return worker;
  };

  const submit = (
    providerId: ProviderId,
    payload: ProviderSearchWorkerInbound,
    id: string,
    onMessage: (message: ProviderSearchWorkerMessage, child: WorkerHandle) => void,
    shouldContinue?: () => boolean,
  ): Promise<ProviderSearchWorkerMessage> => new Promise((resolve, reject) => {
    let worker: PooledWorker;
    try {
      worker = ensureWorker(providerId);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const job: PooledJob = {
      id,
      settled: false,
      onMessage: () => undefined,
      resolve,
      reject,
    };
    const handle: WorkerHandle = {
      kill: () => cancelJob(worker, job),
    };
    job.onMessage = (message) => onMessage(message, handle);
    worker.jobs.set(id, job);

    if (shouldContinue) {
      const timer = setInterval(() => {
        let keepGoing = false;
        try {
          keepGoing = shouldContinue();
        } catch {
          keepGoing = false;
        }

        if (!keepGoing) {
          cancelJob(worker, job);
        }
      }, CANCELLATION_POLL_INTERVAL_MS);
      timer.unref?.();
      job.timer = timer;
    }

    try {
      writeToWorker(worker, payload);
    } catch (error) {
      settleJob(worker, job, () => job.reject(error instanceof Error ? error : new Error(String(error))));
    }
  });

  return {
    run: (input, onMessage, shouldContinue) =>
      submit(input.providerId, input, input.id, onMessage, shouldContinue),
    prewarm: async (providerId) => {
      const id = crypto.randomUUID();
      const result = await submit(
        providerId,
        { id, type: "prewarm", providerId },
        id,
        () => undefined,
      );
      if (result.type !== "prewarm-complete") {
        throw new Error("Search worker returned an unexpected prewarm response.");
      }
    },
    start: () => {
      POOLED_PROVIDER_IDS.forEach((providerId) => {
        try {
          ensureWorker(providerId);
        } catch {
          /* A pool that cannot start is not a startup failure; the next search
             falls back to spawning its own worker and reports the real error. */
        }
      });
    },
    stop: () => {
      [...workers.values()].forEach((worker) => {
        workers.delete(worker.providerId);
        worker.retiring = true;
        worker.child.kill();
      });
    },
    workerPidForTests: (providerId) => workers.get(providerId)?.child.pid,
  };
}

export function createSearchWorkerPoolForTests(options: SearchWorkerPoolOptions): SearchWorkerPool {
  return createSearchWorkerPool(options);
}

function spawnSearchWorkerProcess(): SearchWorkerChild {
  const workerPath = resolveWorkerPath();
  if (!searchWorkerProcessesEnabled() || !workerPath) {
    throw new Error("Search worker processes are disabled or unavailable.");
  }

  const bunExecutable = resolveBunExecutable();
  return Bun.spawn([bunExecutable, workerPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BUN_EXECUTABLE_PATH: bunExecutable,
      FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

let defaultPool: SearchWorkerPool | undefined;

function getDefaultPool(): SearchWorkerPool {
  if (!defaultPool) {
    defaultPool = createSearchWorkerPool({ spawn: spawnSearchWorkerProcess });
  }
  return defaultPool;
}

function poolIsUsable(): boolean {
  return searchWorkerPoolEnabled() && searchWorkerPathAvailable();
}

export function startSearchWorkerPool(): void {
  if (!poolIsUsable()) {
    return;
  }
  getDefaultPool().start();
}

export function stopSearchWorkerPool(): void {
  defaultPool?.stop();
  defaultPool = undefined;
}

export async function prewarmProviderInWorker(providerId: ProviderId): Promise<void> {
  if (!poolIsUsable()) {
    throw new Error("Search worker processes are disabled or unavailable.");
  }
  await getDefaultPool().prewarm(providerId);
}

export function searchWorkerPoolPidForTests(providerId: ProviderId): number | undefined {
  return defaultPool?.workerPidForTests(providerId);
}

function runProviderWorkerJob(
  input: ProviderSearchWorkerRequest,
  onMessage: (message: ProviderSearchWorkerMessage, child: WorkerHandle) => void,
  shouldContinue?: () => boolean,
): Promise<ProviderSearchWorkerMessage> {
  if (poolIsUsable()) {
    return getDefaultPool().run(input, onMessage, shouldContinue);
  }
  return runInWorker(input, onMessage, shouldContinue);
}

export async function runProviderSearchInWorker(input: ProviderSearchWorkerInput): Promise<ProviderSearchResult> {
  const id = crypto.randomUUID();
  const result = await runProviderWorkerJob(
    {
      id,
      kind: input.kind,
      providerId: input.providerId,
      request: input.request,
      providerContext: input.providerContext,
    },
    (message, child) => {
      if (message.type === "provider-event") {
        input.onProviderEvent?.(message.event);
        return;
      }

      if (message.type !== "search-progress") {
        return;
      }

      const keepGoing = input.onProgress?.({
        offers: message.offers,
        warnings: message.warnings,
        partial: message.partial,
        incremental: message.incremental,
      });
      if (keepGoing === false) {
        child.kill();
      }
    },
    input.shouldContinue,
  );

  if (result.type !== "search-complete") {
    throw new Error("Search worker returned an unexpected response.");
  }

  return {
    offers: result.offers,
    warnings: result.warnings,
    partial: result.partial,
  };
}

export async function runProviderMatrixInWorker(input: ProviderMatrixWorkerInput): Promise<MatrixResponse> {
  const id = crypto.randomUUID();
  const result = await runProviderWorkerJob(
    {
      id,
      kind: "matrix",
      providerId: input.providerId,
      request: input.request,
      providerContext: input.providerContext,
      draft: input.draft,
    },
    (message, child) => {
      if (message.type === "provider-event") {
        input.onProviderEvent?.(message.event);
        return;
      }

      if (message.type !== "matrix-progress") {
        return;
      }

      const keepGoing = input.onCellResolved?.(message.cell);
      if (keepGoing === false) {
        child.kill();
      }
    },
    input.shouldContinue,
  );

  if (result.type !== "matrix-complete") {
    throw new Error("Search worker returned an unexpected matrix response.");
  }

  return result.response;
}
