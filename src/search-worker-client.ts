import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  CanonicalOffer,
  MatrixCell,
  MatrixResponse,
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
}

export interface ProviderMatrixWorkerInput {
  providerId: ProviderId;
  request: SearchRequest;
  providerContext?: ProviderContext;
  draft: MatrixResponse;
  onCellResolved?: (cell: MatrixCell) => boolean | void;
}

function searchWorkerProcessesEnabled(): boolean {
  return process.env.FLY_DESK_SEARCH_WORKER_PROCESSES !== "0";
}

function hasTsxLoader(execArgv: string[]): boolean {
  return execArgv.some((arg) => arg === "tsx" || arg.endsWith("/tsx") || arg.endsWith("\\tsx"));
}

function resolveWorkerLaunch(): { modulePath: string; execArgv: string[] } | undefined {
  const jsPath = join(__dirname, "search-worker.js");
  if (existsSync(jsPath)) {
    return {
      modulePath: jsPath,
      execArgv: process.execArgv.filter((arg) => !arg.includes("--watch")),
    };
  }

  const tsPath = join(__dirname, "search-worker.ts");
  if (!existsSync(tsPath)) {
    return undefined;
  }

  const execArgv = process.execArgv.filter((arg) => !arg.includes("--watch"));
  return {
    modulePath: tsPath,
    execArgv: hasTsxLoader(execArgv) ? execArgv : ["--import", "tsx", ...execArgv],
  };
}

function rejectWithWorkerError(message: Extract<ProviderSearchWorkerMessage, { type: "error" }>): Error {
  const error = new Error(message.message);
  error.name = message.name || "ProviderSearchWorkerError";
  if (message.stack) {
    error.stack = message.stack;
  }
  return error;
}

function runInWorker(input: ProviderSearchWorkerRequest, onMessage: (message: ProviderSearchWorkerMessage, child: ChildProcess) => void): Promise<ProviderSearchWorkerMessage> {
  const launch = resolveWorkerLaunch();
  if (!searchWorkerProcessesEnabled() || !launch) {
    return Promise.reject(new Error("Search worker processes are disabled or unavailable."));
  }

  return new Promise((resolve, reject) => {
    const child = fork(launch.modulePath, {
      execArgv: launch.execArgv,
      env: {
        ...process.env,
        FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS: "1",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
      child.kill();
    };

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("message", (message: ProviderSearchWorkerMessage) => {
      if (!message || message.id !== input.id) {
        return;
      }

      onMessage(message, child);
      if (message.type === "search-complete" || message.type === "matrix-complete") {
        finish(() => resolve(message));
      } else if (message.type === "error") {
        finish(() => reject(rejectWithWorkerError(message)));
      }
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }

      const detail = stderr.trim();
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      finish(() => reject(new Error(`Search worker stopped before completing (${reason}).${detail ? ` ${detail}` : ""}`)));
    });

    child.send(input);
  });
}

export async function runProviderSearchInWorker(input: ProviderSearchWorkerInput): Promise<ProviderSearchResult> {
  const id = randomUUID();
  const result = await runInWorker(
    {
      id,
      kind: input.kind,
      providerId: input.providerId,
      request: input.request,
      providerContext: input.providerContext,
    },
    (message, child) => {
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
  const id = randomUUID();
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
      if (message.type !== "matrix-progress") {
        return;
      }

      const keepGoing = input.onCellResolved?.(message.cell);
      if (keepGoing === false) {
        child.kill();
      }
    },
  );

  if (result.type !== "matrix-complete") {
    throw new Error("Search worker returned an unexpected matrix response.");
  }

  return result.response;
}
