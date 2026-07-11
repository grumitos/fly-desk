import {
  createLocalAgilMatrixDraft,
  resolveLocalAgilExactProgressive,
  resolveLocalAgilMatrixProgressive,
  resolveLocalAgilRangeProgressive,
} from "./local-agil";
import {
  createLocalCostamarMatrixDraft,
  resolveLocalCostamarExactProgressive,
  resolveLocalCostamarMatrixProgressive,
  resolveLocalCostamarRangeProgressive,
} from "./local-costamar";
import type { CanonicalOffer, MatrixResponse } from "./core/types";
import {
  createProviderDiagnostics,
  recordProviderDiagnosticEvent,
  withProviderDiagnostics,
} from "./provider-diagnostics";
import type {
  ProviderSearchWorkerComplete,
  ProviderSearchWorkerError,
  ProviderSearchWorkerMessage,
  ProviderSearchWorkerRequest,
} from "./search-worker-protocol";

function send(message: ProviderSearchWorkerMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function serializeError(id: string, error: unknown): ProviderSearchWorkerError {
  return {
    id,
    type: "error",
    message: error instanceof Error ? error.message : "Provider search worker failed.",
    name: error instanceof Error ? error.name : undefined,
    stack: error instanceof Error ? error.stack : undefined,
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
            return true;
          })
        : await resolveLocalAgilMatrixProgressive(input.request, draft, (cell) => {
            send({ id: input.id, type: "matrix-progress", cell });
            return true;
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
      return true;
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
  void runProviderSearch(message)
    .then((result) => send(result))
    .catch((error) => send(serializeError(message.id, error)))
    .finally(() => {
      pendingMessages -= 1;
      maybeExit();
    });
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
      handleWorkerRequest(JSON.parse(line) as ProviderSearchWorkerRequest);
    } catch (error) {
      send(serializeError("unknown", error));
    }
  }
});

process.stdin.on("end", () => {
  const line = inputBuffer.trim();
  inputBuffer = "";
  if (line) {
    try {
      handleWorkerRequest(JSON.parse(line) as ProviderSearchWorkerRequest);
    } catch (error) {
      send(serializeError("unknown", error));
    }
  }

  stdinEnded = true;
  maybeExit();
});
