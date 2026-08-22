import type {
  CanonicalOffer,
  MatrixCell,
  MatrixResponse,
  ProviderDiagnosticEvent,
  ProviderContext,
  ProviderId,
  SearchRequest,
} from "./core/types";

export interface ProviderSearchWorkerRequest {
  id: string;
  kind: "exact" | "range" | "matrix";
  providerId: ProviderId;
  request: SearchRequest;
  providerContext?: ProviderContext;
  draft?: MatrixResponse;
}

/* Cooperative cancellation: the worker keeps serving the job until its provider
   callbacks are asked whether to continue, and answers "no" from then on. */
export interface ProviderSearchWorkerCancel {
  id: string;
  type: "cancel";
}

export interface ProviderSearchWorkerPrewarm {
  id: string;
  type: "prewarm";
  providerId: ProviderId;
}

/* The search request stays untyped so older callers keep working; every other
   inbound message carries a `type`, which is how the worker discriminates. */
export type ProviderSearchWorkerInbound =
  | ProviderSearchWorkerRequest
  | ProviderSearchWorkerCancel
  | ProviderSearchWorkerPrewarm;

export type ProviderSearchWorkerProgress =
  | {
      id: string;
      type: "search-progress";
      offers: CanonicalOffer[];
      warnings: string[];
      partial: boolean;
      incremental?: boolean;
    }
  | {
      id: string;
      type: "matrix-progress";
      cell: MatrixCell;
    }
  | {
      id: string;
      type: "provider-event";
      event: ProviderDiagnosticEvent;
    };

export type ProviderSearchWorkerComplete =
  | {
      id: string;
      type: "search-complete";
      offers: CanonicalOffer[];
      warnings: string[];
      partial: boolean;
    }
  | {
      id: string;
      type: "matrix-complete";
      response: MatrixResponse;
    };

export interface ProviderSearchWorkerPrewarmComplete {
  id: string;
  type: "prewarm-complete";
}

export interface ProviderSearchWorkerError {
  id: string;
  type: "error";
  message: string;
  name?: string;
  stack?: string;
}

export type ProviderSearchWorkerMessage =
  | ProviderSearchWorkerProgress
  | ProviderSearchWorkerComplete
  | ProviderSearchWorkerPrewarmComplete
  | ProviderSearchWorkerError;
