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
  ProviderSearchWorkerMessage,
  ProviderSearchWorkerRequest,
} from "./search-worker-protocol";

export interface ProviderSearchResult {
  offers: CanonicalOffer[];
  warnings: string[];
  partial: boolean;
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

function searchWorkerProcessesEnabled(): boolean {
  return process.env.FLY_DESK_SEARCH_WORKER_PROCESSES !== "0";
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
    void readJsonLines(child.stdout, (line) => {
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
      if (settled) {
        return;
      }

      const detail = (await stderrPromise).trim();
      finish(() => reject(new Error(
        `Search worker stopped before completing (exit code ${code ?? "unknown"}).${detail ? ` ${detail}` : ""}`,
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

export async function runProviderSearchInWorker(input: ProviderSearchWorkerInput): Promise<ProviderSearchResult> {
  const id = crypto.randomUUID();
  const result = await runInWorker(
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
  const result = await runInWorker(
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
