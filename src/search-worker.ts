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

/* Jobs the client gave up on. The provider callbacks answer `false` from here
   on, which is what stops the remaining fan-out inside a pooled worker that
   must stay alive for the other jobs it is multiplexing. */
const cancelledJobIds = new Set<string>();
const activeJobIds = new Set<string>();

function jobIsLive(id: string): boolean {
  return !cancelledJobIds.has(id);
}

function send(message: ProviderSearchWorkerMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

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

async function runProviderSearch(input: ProviderSearchWorkerRequest): Promise<ProviderSearchWorkerComplete> {
  const diagnostics = createProviderDiagnostics(input.providerId, input.kind === "matrix" ? "matrix" : input.kind);
  diagnostics.events = [];
  const emitEvent = (event: typeof diagnostics.events[number]) => {
    send({ id: input.id, type: "provider-event", event });
  };

  return withProviderDiagnostics(diagnostics, emitEvent, async () => {
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
  });
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
  activeJobIds.add(message.id);
  void runProviderSearch(message)
    .then((result) => send(result))
    .catch((error) => send(serializeError(message.id, message.providerId, error)))
    .finally(() => {
      activeJobIds.delete(message.id);
      cancelledJobIds.delete(message.id);
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
    /* A cancel that lands after the job settled has nothing to stop; recording
       it would only pin the id in memory for the worker's lifetime. */
    if (activeJobIds.has(message.id)) {
      cancelledJobIds.add(message.id);
    }
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
  maybeExit();
});
