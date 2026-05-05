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
import type {
  ProviderSearchWorkerComplete,
  ProviderSearchWorkerError,
  ProviderSearchWorkerMessage,
  ProviderSearchWorkerRequest,
} from "./search-worker-protocol";

function send(message: ProviderSearchWorkerMessage): void {
  process.send?.(message);
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

  const onProgress = (partialResult: { offers: CanonicalOffer[]; warnings: string[]; partial: boolean }) => {
    send({
      id: input.id,
      type: "search-progress",
      offers: partialResult.offers,
      warnings: partialResult.warnings,
      partial: partialResult.partial,
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
}

process.on("message", (message: ProviderSearchWorkerRequest) => {
  void runProviderSearch(message)
    .then((result) => send(result))
    .catch((error) => send(serializeError(message.id, error)));
});
