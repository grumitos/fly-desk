import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ProviderDiagnosticEvent,
  ProviderDiagnosticKind,
  ProviderDiagnostics,
  ProviderDiagnosticStatus,
  ProviderId,
} from "./core/types";

interface ProviderDiagnosticsContext {
  diagnostics: ProviderDiagnostics;
  firstHttpRequestRecorded: boolean;
  onEvent?: (event: ProviderDiagnosticEvent) => void;
}

const providerDiagnosticsStorage = new AsyncLocalStorage<ProviderDiagnosticsContext>();

function eventBaseTimeMs(diagnostics: ProviderDiagnostics): number {
  const firstEvent = diagnostics.events[0];
  const parsed = firstEvent ? Date.parse(firstEvent.at) : Date.now();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function sanitizeDiagnosticDetail(detail: string | undefined): string | undefined {
  const normalized = detail
    ?.replace(/([?&]token=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return undefined;
  }

  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

export function cloneProviderDiagnostics(diagnostics: ProviderDiagnostics): ProviderDiagnostics {
  return {
    ...diagnostics,
    events: diagnostics.events.map((event) => ({ ...event })),
  };
}

export function createProviderDiagnostics(
  providerId: ProviderId,
  kind: ProviderDiagnosticKind,
  detail?: string,
): ProviderDiagnostics {
  const diagnostics: ProviderDiagnostics = {
    providerId,
    kind,
    status: "queued",
    events: [],
  };
  appendProviderDiagnosticEvent(diagnostics, "queued", detail);
  return diagnostics;
}

export function appendProviderDiagnosticEvent(
  diagnostics: ProviderDiagnostics,
  name: string,
  detail?: string,
): ProviderDiagnosticEvent {
  const nowMs = Date.now();
  const event: ProviderDiagnosticEvent = {
    name,
    at: new Date(nowMs).toISOString(),
    elapsedMs: Math.max(0, nowMs - eventBaseTimeMs(diagnostics)),
    detail: sanitizeDiagnosticDetail(detail),
  };

  diagnostics.events.push(event);
  return event;
}

export function setProviderDiagnosticStatus(
  diagnostics: ProviderDiagnostics,
  status: ProviderDiagnosticStatus,
  summary?: Pick<ProviderDiagnostics, "offers" | "warningCount" | "error">,
): ProviderDiagnostics {
  diagnostics.status = status;
  if (summary && typeof summary.offers === "number") {
    diagnostics.offers = summary.offers;
  }
  if (summary && typeof summary.warningCount === "number") {
    diagnostics.warningCount = summary.warningCount;
  }
  if (summary?.error) {
    diagnostics.error = sanitizeDiagnosticDetail(summary.error);
  } else if (status !== "failed") {
    delete diagnostics.error;
  }
  return diagnostics;
}

export async function withProviderDiagnostics<T>(
  diagnostics: ProviderDiagnostics,
  onEvent: ((event: ProviderDiagnosticEvent) => void) | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return providerDiagnosticsStorage.run({
    diagnostics,
    firstHttpRequestRecorded: false,
    onEvent,
  }, run);
}

export function recordProviderDiagnosticEvent(name: string, detail?: string): ProviderDiagnosticEvent | undefined {
  const context = providerDiagnosticsStorage.getStore();
  if (!context) {
    return undefined;
  }

  const event = appendProviderDiagnosticEvent(context.diagnostics, name, detail);
  context.onEvent?.(event);
  return event;
}

export function recordProviderFirstHttpRequest(detail?: string): ProviderDiagnosticEvent | undefined {
  const context = providerDiagnosticsStorage.getStore();
  if (!context || context.firstHttpRequestRecorded) {
    return undefined;
  }

  context.firstHttpRequestRecorded = true;
  return recordProviderDiagnosticEvent("first_http_request", detail);
}
