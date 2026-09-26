import {
  createLocalAgilMatrixDraft,
  prewarmLocalAgilSession,
  resolveLocalAgilExactProgressive,
  resolveLocalAgilMatrixProgressive,
  resolveLocalAgilRangeProgressive,
} from "./local-agil";
import {
  createLocalCostamarMatrixDraft,
  prewarmLocalCostamarContext,
  resolveLocalCostamarExactProgressive,
  resolveLocalCostamarMatrixProgressive,
  resolveLocalCostamarRangeProgressive,
} from "./local-costamar";
import { closeOpenBrowserTargets } from "./browser-targets";
import { withProviderJobSignal } from "./provider-fetch";
import type { CanonicalOffer, MatrixResponse, ProviderId } from "./core/types";
import {
  createProviderDiagnostics,
  recordProviderDiagnosticEvent,
  withProviderDiagnostics,
} from "./provider-diagnostics";
import { providerPublicFailureMessage } from "./provider-status";
import type {
  ProviderSearchWorkerComplete,
  ProviderSearchWorkerError,
  ProviderSearchWorkerInbound,
  ProviderSearchWorkerMessage,
  ProviderSearchWorkerPrewarm,
  ProviderSearchWorkerRequest,
} from "./search-worker-protocol";

/* The jobs this worker is running, each with the signal that stops it. A job
   the client gives up on is aborted: its provider requests in flight are cut
   (`fetchProvider`), no new one is sent, and its provider callbacks answer
   `false`, which ends the fan-out inside a pooled worker that stays alive for
   the other jobs it is multiplexing. */
const runningJobs = new Map<string, AbortController>();

/*
 * How long a stopping worker spends closing the tabs it has open in the shared
 * Chrome, which outlives it. The runner gives its whole stop 8 s, and systemd
 * kills what is left of the unit 15 s after the stop began.
 */
const STOP_TAB_CLOSE_TIMEOUT_MS = 2_000;
/*
 * How long the jobs of a signalled worker run on while its runner decides how
 * they end. The runner lets them finish for 3 s, cancels the rest keeping what
 * they found, and then stops its workers itself; this bound only matters when
 * it never does.
 */
const STOP_GRACE_MS = 6_000;
/* Set once the worker hangs up on its jobs; it sends nothing after that. */
let stopping = false;
let stopGrace: ReturnType<typeof setTimeout> | undefined;

function jobIsLive(id: string): boolean {
  return !stopping && runningJobs.get(id)?.signal.aborted === false;
}

function send(message: ProviderSearchWorkerMessage): void {
  /* Nobody reads a stopping worker. */
  if (stopping) {
    return;
  }
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/*
 * Hangs up on every job left, closes the tabs the worker has open, within a
 * bound, and exits. Left to its default a signal would end the worker before
 * the `finally` that closes its tab.
 */
function stopNow(): void {
  if (stopping) {
    return;
  }
  stopping = true;
  clearTimeout(stopGrace);
  for (const controller of runningJobs.values()) {
    controller.abort();
  }
  void closeOpenBrowserTargets(STOP_TAB_CLOSE_TIMEOUT_MS).finally(() => process.exit(0));
}

/*
 * A worker is signalled with its runner: systemd signals every process of the
 * unit at once, and a terminal every process of its group. The jobs it runs
 * belong to the runner's stop, which lets them finish for a moment and cancels
 * the rest keeping what they found; a worker that died on that same signal
 * would turn each of them into a provider failure. So the first signal while
 * jobs run leaves them running, their answers still sent, until the runner
 * stops the worker (a second signal, or its input closing) or `STOP_GRACE_MS`
 * passes. A worker with no job, or stopped by its runner, stops at once.
 */
function stopOnSignal(): void {
  if (stopGrace || stdinEnded || runningJobs.size === 0) {
    stopNow();
    return;
  }
  stopGrace = setTimeout(stopNow, STOP_GRACE_MS);
}

process.on("SIGTERM", stopOnSignal);
process.on("SIGINT", stopOnSignal);

function serializeError(
  id: string,
  providerId: ProviderId | undefined,
  error: unknown,
): ProviderSearchWorkerError {
  return {
    id,
    type: "error",
    message: providerId
      ? providerPublicFailureMessage(providerId, error)
      : "Provider search worker rejected an invalid request.",
  };
}

function createMatrixDraft(input: ProviderSearchWorkerRequest): MatrixResponse {
  if (input.draft) {
    return input.draft;
  }

  const draftMeta = {
    exactProvider: input.providerId,
    coverageMode: input.request.coverageMode,
  };
  return input.providerId === "costamar"
    ? createLocalCostamarMatrixDraft(input.request, draftMeta)
    : createLocalAgilMatrixDraft(input.request, draftMeta);
}

async function runProviderSearch(input: ProviderSearchWorkerRequest, signal: AbortSignal): Promise<ProviderSearchWorkerComplete> {
  const diagnostics = createProviderDiagnostics(input.providerId, input.kind === "matrix" ? "matrix" : input.kind);
  diagnostics.events = [];
  const emitEvent = (event: typeof diagnostics.events[number]) => {
    send({ id: input.id, type: "provider-event", event });
  };

  return withProviderDiagnostics(diagnostics, emitEvent, () => withProviderJobSignal(signal, async () => {
    recordProviderDiagnosticEvent("provider_started");

    if (input.kind === "matrix") {
      const draft = createMatrixDraft(input);
      const response = input.providerId === "costamar"
        ? await resolveLocalCostamarMatrixProgressive(input.request, input.providerContext, draft, (cell) => {
            send({ id: input.id, type: "matrix-progress", cell });
            return jobIsLive(input.id);
          })
        : await resolveLocalAgilMatrixProgressive(input.request, draft, (cell) => {
            send({ id: input.id, type: "matrix-progress", cell });
            return jobIsLive(input.id);
          });

      return {
        id: input.id,
        type: "matrix-complete",
        response,
      };
    }

    const onProgress = (partialResult: { offers: CanonicalOffer[]; warnings: string[]; partial: boolean; incremental?: boolean }) => {
      send({
        id: input.id,
        type: "search-progress",
        offers: partialResult.offers,
        warnings: partialResult.warnings,
        partial: partialResult.partial,
        incremental: partialResult.incremental,
      });
      return jobIsLive(input.id);
    };

    const result = input.providerId === "costamar"
      ? input.kind === "range"
        ? await resolveLocalCostamarRangeProgressive(input.request, input.providerContext, onProgress)
        : await resolveLocalCostamarExactProgressive(input.request, input.providerContext, onProgress)
      : input.kind === "range"
        ? await resolveLocalAgilRangeProgressive(input.request, onProgress)
        : await resolveLocalAgilExactProgressive(input.request, onProgress);

    return {
      id: input.id,
      type: "search-complete",
      offers: result.offers,
      warnings: result.warnings,
      partial: result.partial,
    };
  }));
}

let pendingMessages = 0;
let stdinEnded = false;
let inputBuffer = "";

function maybeExit(): void {
  if (stdinEnded && pendingMessages === 0) {
    process.exit(0);
  }
}

function handleWorkerRequest(message: ProviderSearchWorkerRequest): void {
  pendingMessages += 1;
  const controller = new AbortController();
  runningJobs.set(message.id, controller);
  void runProviderSearch(message, controller.signal)
    .then((result) => send(result))
    .catch((error) => send(serializeError(message.id, message.providerId, error)))
    .finally(() => {
      runningJobs.delete(message.id);
      pendingMessages -= 1;
      maybeExit();
    });
}

function handlePrewarmRequest(message: ProviderSearchWorkerPrewarm): void {
  pendingMessages += 1;
  const prewarmed = message.providerId === "costamar"
    ? Promise.resolve().then(() => prewarmLocalCostamarContext())
    : Promise.resolve().then(() => prewarmLocalAgilSession());
  void prewarmed
    .then(() => send({ id: message.id, type: "prewarm-complete" }))
    .catch((error) => send(serializeError(message.id, message.providerId, error)))
    .finally(() => {
      pendingMessages -= 1;
      maybeExit();
    });
}

function handleInboundMessage(message: ProviderSearchWorkerInbound): void {
  if (!("type" in message)) {
    handleWorkerRequest(message);
    return;
  }

  if (message.type === "cancel") {
    /* A cancel that lands after the job settled finds nothing to stop. */
    runningJobs.get(message.id)?.abort();
    return;
  }

  if (message.type === "prewarm") {
    handlePrewarmRequest(message);
    return;
  }

  send(serializeError("unknown", undefined, new Error("Unsupported worker message.")));
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += String(chunk);
  for (;;) {
    const newlineIndex = inputBuffer.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }

    const line = inputBuffer.slice(0, newlineIndex).trim();
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    if (!line) {
      continue;
    }

    try {
      handleInboundMessage(JSON.parse(line) as ProviderSearchWorkerInbound);
    } catch (error) {
      send(serializeError("unknown", undefined, error));
    }
  }
});

process.stdin.on("end", () => {
  const line = inputBuffer.trim();
  inputBuffer = "";
  if (line) {
    try {
      handleInboundMessage(JSON.parse(line) as ProviderSearchWorkerInbound);
    } catch (error) {
      send(serializeError("unknown", undefined, error));
    }
  }

  stdinEnded = true;
  /* A runner that closes the input of a signalled worker is stopping it. */
  if (stopGrace) {
    stopNow();
    return;
  }
  maybeExit();
});
