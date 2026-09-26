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

/*
 * How a job is stopped. `signal` is the job's own stop, heard at once;
 * `shouldContinue` is asked every `CANCELLATION_POLL_INTERVAL_MS` and catches
 * a job that left the running state without its signal.
 */
interface WorkerJobStop {
  signal?: AbortSignal;
  shouldContinue?: () => boolean;
}

interface ProviderSearchWorkerInput extends WorkerJobStop {
  kind: "exact" | "range";
  providerId: ProviderId;
  request: SearchRequest;
  providerContext?: ProviderContext;
  onProgress?: (result: ProviderSearchResult) => boolean | void;
  onProviderEvent?: (event: ProviderDiagnosticEvent) => void;
}

interface ProviderMatrixWorkerInput extends WorkerJobStop {
  providerId: ProviderId;
  request: SearchRequest;
  providerContext?: ProviderContext;
  draft: MatrixResponse;
  onCellResolved?: (cell: MatrixCell) => boolean | void;
  onProviderEvent?: (event: ProviderDiagnosticEvent) => void;
}

interface WorkerHandle {
  kill: () => void;
}

const POOLED_PROVIDER_IDS = ["agil-local", "costamar"] as const satisfies readonly ProviderId[];
const DEFAULT_SEARCH_WORKER_MAX_JOBS = 500;
const CANCELLATION_POLL_INTERVAL_MS = 500;
/* A hang guard, not a budget: a month of a migratory sweep is the longest
   legitimate job and takes a few minutes. Past this the job is cancelled and
   its search capacity released. */
const DEFAULT_SEARCH_WORKER_JOB_TIMEOUT_MS = 10 * 60_000;
const WORKER_LOG_LINE_MAX_CHARS = 400;

function searchWorkerJobTimeoutMs(): number {
  const raw = Number(process.env.FLY_DESK_SEARCH_WORKER_JOB_TIMEOUT_MS ?? DEFAULT_SEARCH_WORKER_JOB_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_SEARCH_WORKER_JOB_TIMEOUT_MS;
}

function workerJobTimeoutError(): Error {
  return new Error("Search worker job exceeded its deadline.");
}

/* Provider errors can carry URLs with tokens in them, so a worker's stderr
   reaches the journal with URLs cut to their origin and token-shaped strings
   removed. */
function redactWorkerLogLine(line: string): string {
  return line
    .replace(/https?:\/\/[^\s"'<>]+/g, (url) => {
      try {
        return new URL(url).origin;
      } catch {
        return "<url>";
      }
    })
    .replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/g, "<jwt>")
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, "<redacted>")
    .slice(0, WORKER_LOG_LINE_MAX_CHARS);
}

/* Resolves, once the stream ends, with whether the worker wrote anything. */
function forwardWorkerStderr(stream: ReadableStream<Uint8Array>, providerId: ProviderId): Promise<boolean> {
  let emitted = false;
  return readLines(stream, (line) => {
    emitted = true;
    console.warn(`[search-worker ${providerId}] ${redactWorkerLogLine(line)}`);
  }).then(() => emitted, () => emitted);
}

function searchWorkerProcessesEnabled(): boolean {
  return process.env.FLY_DESK_SEARCH_WORKER_PROCESSES !== "0";
}

/* The pool is the default path; `0` spawns one worker per search through
   `runInWorker`, which is kept as a working escape hatch. */
export function searchWorkerPoolEnabled(): boolean {
  return searchWorkerProcessesEnabled()
    && String(process.env.FLY_DESK_SEARCH_WORKER_POOL ?? "1").trim() !== "0";
}

function searchWorkerMaxJobs(): number {
  const raw = Number(process.env.FLY_DESK_SEARCH_WORKER_MAX_JOBS ?? DEFAULT_SEARCH_WORKER_MAX_JOBS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_SEARCH_WORKER_MAX_JOBS;
}

/*
 * A worker runs with Bun's small heap (`--smol`), which collects more often:
 * it only relays each day's fares to the runner, and in the runner's memory
 * limit it then gives back what a month took. Measured over a two-month sweep
 * beside another agent's range, the two workers held 199 MiB between searches
 * without it and 139 MiB with it.
 */
const WORKER_BUN_FLAGS = ["--smol", "--no-env-file"] as const;

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

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  /* A progress message can be megabytes, so a partial line is kept as chunks
     and only the newest chunk is searched for the newline. */
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending: string[] = [];

  const emit = (line: string) => {
    const trimmed = line.trim();
    if (trimmed) {
      onLine(trimmed);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const chunk = decoder.decode(value, { stream: true });
    let start = 0;
    let newlineIndex = chunk.indexOf("\n");
    while (newlineIndex !== -1) {
      pending.push(chunk.slice(start, newlineIndex));
      emit(pending.join(""));
      pending = [];
      start = newlineIndex + 1;
      newlineIndex = chunk.indexOf("\n", start);
    }
    if (start < chunk.length) {
      pending.push(chunk.slice(start));
    }
  }

  pending.push(decoder.decode());
  emit(pending.join(""));
}

function runInWorker(
  input: ProviderSearchWorkerRequest,
  onMessage: (message: ProviderSearchWorkerMessage, child: WorkerHandle) => void,
  { signal, shouldContinue }: WorkerJobStop = {},
): Promise<ProviderSearchWorkerMessage> {
  const workerPath = resolveWorkerPath();
  if (!searchWorkerProcessesEnabled() || !workerPath) {
    return Promise.reject(new Error("Search worker processes are disabled or unavailable."));
  }
  if (signal?.aborted) {
    return Promise.reject(new Error("Search worker cancelled."));
  }

  return new Promise((resolve, reject) => {
    const bunExecutable = resolveBunExecutable();
    const child = Bun.spawn([bunExecutable, ...WORKER_BUN_FLAGS, workerPath], {
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

    const stopOnSignal = () => finish(() => reject(new Error("Search worker cancelled.")));
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (cancellationTimer) {
        clearInterval(cancellationTimer);
      }
      clearTimeout(deadline);
      signal?.removeEventListener("abort", stopOnSignal);
      callback();
      child.kill();
    };
    const deadline = setTimeout(() => finish(() => reject(workerJobTimeoutError())), searchWorkerJobTimeoutMs());
    deadline.unref?.();
    signal?.addEventListener("abort", stopOnSignal, { once: true });

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

    const stderrPromise = forwardWorkerStderr(child.stderr, input.providerId);
    const stdoutDrained = readLines(child.stdout, (line) => {
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
      /* The answer on stdout and the exit can arrive in either order; reading
         what is left first keeps a provider error from being reported as "the
         worker stopped". */
      await stdoutDrained;
      if (settled) {
        return;
      }

      const hadDiagnostics = await stderrPromise;
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

interface SearchWorkerChildStdin {
  write: (chunk: Uint8Array) => unknown;
  end: () => unknown;
  flush?: () => unknown;
}

interface SearchWorkerChild {
  readonly pid?: number;
  readonly stdin: SearchWorkerChildStdin;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number | null>;
  kill: () => void;
}

type SearchWorkerSpawn = (providerId: ProviderId) => SearchWorkerChild;

interface SearchWorkerPool {
  run: (
    input: ProviderSearchWorkerRequest,
    onMessage: (message: ProviderSearchWorkerMessage, child: WorkerHandle) => void,
    stop?: WorkerJobStop,
  ) => Promise<ProviderSearchWorkerMessage>;
  prewarm: (providerId: ProviderId) => Promise<void>;
  start: () => void;
  /** Resolves once every worker has exited. */
  stop: () => Promise<void>;
}

interface PooledJob {
  id: string;
  settled: boolean;
  onMessage: (message: ProviderSearchWorkerMessage) => void;
  resolve: (message: ProviderSearchWorkerMessage) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setInterval>;
  deadline?: ReturnType<typeof setTimeout>;
  detach?: () => void;
}

interface PooledWorker {
  providerId: ProviderId;
  child: SearchWorkerChild;
  jobs: Map<string, PooledJob>;
  completedJobs: number;
  retiring: boolean;
  stderr: Promise<boolean>;
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
    clearTimeout(job.deadline);
    job.detach?.();
    worker.jobs.delete(job.id);
    worker.completedJobs += 1;
    complete();
    maybeRecycle(worker);
  };

  const cancelJob = (worker: PooledWorker, job: PooledJob, reason = new Error("Search worker cancelled.")): void => {
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
    settleJob(worker, job, () => job.reject(reason));
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
      stderr: forwardWorkerStderr(child.stderr, providerId),
    };
    workers.set(providerId, worker);

    const stdoutDrained = readLines(child.stdout, (line) => {
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

      const hadDiagnostics = await worker.stderr;
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
    { signal, shouldContinue }: WorkerJobStop = {},
  ): Promise<ProviderSearchWorkerMessage> => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Search worker cancelled."));
      return;
    }

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
    job.deadline = setTimeout(() => cancelJob(worker, job, workerJobTimeoutError()), searchWorkerJobTimeoutMs());
    job.deadline.unref?.();

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
    if (signal) {
      const stop = () => cancelJob(worker, job);
      signal.addEventListener("abort", stop, { once: true });
      job.detach = () => signal.removeEventListener("abort", stop);
    }

    try {
      writeToWorker(worker, payload);
    } catch (error) {
      settleJob(worker, job, () => job.reject(error instanceof Error ? error : new Error(String(error))));
    }
  });

  return {
    run: (input, onMessage, stop) =>
      submit(input.providerId, input, input.id, onMessage, stop),
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
    /* Closing its input and signalling it both tell a worker to stop now,
       whichever reaches it first: one already signalled with the unit is
       waiting for exactly this (`src/search-worker.ts`). */
    stop: () => Promise.all([...workers.values()].map((worker) => {
      workers.delete(worker.providerId);
      worker.retiring = true;
      try {
        worker.child.stdin.end();
      } catch {
        /* Already closed: the signal below is enough. */
      }
      worker.child.kill();
      return Promise.resolve(worker.child.exited).then(() => undefined, () => undefined);
    })).then(() => undefined),
  };
}

function spawnSearchWorkerProcess(): SearchWorkerChild {
  const workerPath = resolveWorkerPath();
  if (!searchWorkerProcessesEnabled() || !workerPath) {
    throw new Error("Search worker processes are disabled or unavailable.");
  }

  const bunExecutable = resolveBunExecutable();
  return Bun.spawn([bunExecutable, ...WORKER_BUN_FLAGS, workerPath], {
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

/** Stops the pooled workers; resolves once they have exited. */
export function stopSearchWorkerPool(): Promise<void> {
  const stopped = defaultPool?.stop() ?? Promise.resolve();
  defaultPool = undefined;
  return stopped;
}

export async function prewarmProviderInWorker(providerId: ProviderId): Promise<void> {
  if (!poolIsUsable()) {
    throw new Error("Search worker processes are disabled or unavailable.");
  }
  await getDefaultPool().prewarm(providerId);
}

function runProviderWorkerJob(
  input: ProviderSearchWorkerRequest,
  onMessage: (message: ProviderSearchWorkerMessage, child: WorkerHandle) => void,
  stop: WorkerJobStop,
): Promise<ProviderSearchWorkerMessage> {
  if (poolIsUsable()) {
    return getDefaultPool().run(input, onMessage, stop);
  }
  return runInWorker(input, onMessage, stop);
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
    { signal: input.signal, shouldContinue: input.shouldContinue },
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
    { signal: input.signal, shouldContinue: input.shouldContinue },
  );

  if (result.type !== "matrix-complete") {
    throw new Error("Search worker returned an unexpected matrix response.");
  }

  return result.response;
}
