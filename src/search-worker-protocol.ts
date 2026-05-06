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

export type ProviderSearchWorkerProgress =
  | {
      id: string;
      type: "search-progress";
      offers: CanonicalOffer[];
      warnings: string[];
      partial: boolean;
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
  | ProviderSearchWorkerError;
