import type { ProviderId } from "./core/types";

export interface ProviderStatusDefinition {
  readonly id: ProviderId;
  readonly label: string;
}

export const PROVIDER_STATUS_DEFINITIONS: readonly ProviderStatusDefinition[] =
  Object.freeze([
    Object.freeze({ id: "agil-local", label: "Agilsmart" }),
    Object.freeze({ id: "costamar", label: "Click and Book Plus" }),
  ]);

export const PROVIDER_STATUS_STATES = Object.freeze([
  "unknown",
  "checking",
  "ready",
  "degraded",
] as const);

export type ProviderStatusState = (typeof PROVIDER_STATUS_STATES)[number];

export const PROVIDER_STATUS_EVIDENCE = Object.freeze([
  "prewarm",
  "search",
] as const);

export type ProviderStatusEvidence = (typeof PROVIDER_STATUS_EVIDENCE)[number];

export const PROVIDER_DEGRADED_REASON_CODES = Object.freeze([
  "authentication_required",
  "provider_unavailable",
  "timeout",
  "invalid_response",
  "partial_results",
  "provider_error",
] as const);

export type ProviderDegradedReasonCode =
  (typeof PROVIDER_DEGRADED_REASON_CODES)[number];

export const PROVIDER_STATUS_REASON_CODES = Object.freeze([
  "not_configured",
  "not_checked",
  "check_in_progress",
  "context_only",
  "stale",
  ...PROVIDER_DEGRADED_REASON_CODES,
] as const);

export type ProviderStatusReasonCode =
  (typeof PROVIDER_STATUS_REASON_CODES)[number];

export interface ProviderStatusSnapshot {
  readonly id: ProviderId;
  readonly label: string;
  readonly configured: boolean;
  readonly state: ProviderStatusState;
  readonly evidence: ProviderStatusEvidence | null;
  readonly reasonCode: ProviderStatusReasonCode | null;
  readonly observedAtMs: number | null;
  readonly stale: boolean;
}

export type ProviderStatusClock = () => number;

export interface ProviderStatusTrackerOptions {
  readonly clock?: ProviderStatusClock;
  readonly ttlMs?: number;
  readonly configuredProviderIds?: readonly ProviderId[];
}

interface ProviderStatusRecord {
  readonly configured: boolean;
  readonly state: ProviderStatusState;
  readonly evidence: ProviderStatusEvidence | null;
  readonly reasonCode: ProviderStatusReasonCode | null;
  readonly observedAtMs: number | null;
}

export const DEFAULT_PROVIDER_STATUS_TTL_MS = 5 * 60_000;

const PROVIDER_IDS = Object.freeze(
  PROVIDER_STATUS_DEFINITIONS.map(({ id }) => id),
);

function isAllowedValue<T extends string>(
  allowedValues: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && allowedValues.includes(value as T);
}

function assertProviderId(value: unknown): asserts value is ProviderId {
  if (!isAllowedValue(PROVIDER_IDS, value)) {
    throw new Error("Unsupported provider status value.");
  }
}

function assertEvidence(
  value: unknown,
): asserts value is ProviderStatusEvidence {
  if (!isAllowedValue(PROVIDER_STATUS_EVIDENCE, value)) {
    throw new Error("Unsupported provider status evidence.");
  }
}

function assertDegradedReasonCode(
  value: unknown,
): asserts value is ProviderDegradedReasonCode {
  if (!isAllowedValue(PROVIDER_DEGRADED_REASON_CODES, value)) {
    throw new Error("Unsupported provider status reason code.");
  }
}

function validateTtlMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error("Provider status TTL must be a finite non-negative number.");
  }
  return ttlMs;
}

export class ProviderStatusTracker {
  readonly #clock: ProviderStatusClock;
  readonly #ttlMs: number;
  readonly #records = new Map<ProviderId, ProviderStatusRecord>();

  constructor(options: ProviderStatusTrackerOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#ttlMs = validateTtlMs(
      options.ttlMs ?? DEFAULT_PROVIDER_STATUS_TTL_MS,
    );

    const configuredProviderIds =
      options.configuredProviderIds ?? PROVIDER_IDS;
    const configured = new Set<ProviderId>();
    for (const providerId of configuredProviderIds) {
      assertProviderId(providerId);
      configured.add(providerId);
    }

    for (const { id } of PROVIDER_STATUS_DEFINITIONS) {
      const isConfigured = configured.has(id);
      this.#records.set(id, {
        configured: isConfigured,
        state: "unknown",
        evidence: null,
        reasonCode: isConfigured ? "not_checked" : "not_configured",
        observedAtMs: null,
      });
    }
  }

  markChecking(
    providerId: ProviderId,
    evidence: ProviderStatusEvidence,
  ): void {
    const record = this.#configuredRecord(providerId);
    assertEvidence(evidence);
    const now = this.#now();
    if (this.#shouldKeepFreshSearchEvidence(record, evidence, now)) {
      return;
    }
    this.#records.set(providerId, {
      ...record,
      state: "checking",
      evidence,
      reasonCode: "check_in_progress",
      observedAtMs: now,
    });
  }

  recordReady(
    providerId: "agil-local",
    evidence: ProviderStatusEvidence,
  ): void;
  recordReady(providerId: "costamar", evidence: "search"): void;
  recordReady(
    providerId: ProviderId,
    evidence: ProviderStatusEvidence,
  ): void {
    const record = this.#configuredRecord(providerId);
    assertEvidence(evidence);
    if (providerId === "costamar" && evidence === "prewarm") {
      throw new Error("Costamar prewarm only verifies local context.");
    }
    const now = this.#now();
    if (this.#shouldKeepFreshSearchEvidence(record, evidence, now)) {
      return;
    }
    this.#records.set(providerId, {
      ...record,
      state: "ready",
      evidence,
      reasonCode: null,
      observedAtMs: now,
    });
  }

  recordDegraded(
    providerId: ProviderId,
    evidence: ProviderStatusEvidence,
    reasonCode: ProviderDegradedReasonCode,
  ): void {
    const record = this.#configuredRecord(providerId);
    assertEvidence(evidence);
    assertDegradedReasonCode(reasonCode);
    const now = this.#now();
    if (this.#shouldKeepFreshSearchEvidence(record, evidence, now)) {
      return;
    }
    this.#records.set(providerId, {
      ...record,
      state: "degraded",
      evidence,
      reasonCode,
      observedAtMs: now,
    });
  }

  recordCostamarContextAvailable(): void {
    const record = this.#configuredRecord("costamar");
    const now = this.#now();
    if (this.#shouldKeepFreshSearchEvidence(record, "prewarm", now)) {
      return;
    }
    this.#records.set("costamar", {
      ...record,
      state: "unknown",
      evidence: "prewarm",
      reasonCode: "context_only",
      observedAtMs: now,
    });
  }

  recordSearchResult(providerId: ProviderId, partial: boolean): void {
    if (partial) {
      this.recordDegraded(providerId, "search", "partial_results");
      return;
    }
    if (providerId === "costamar") {
      this.recordReady("costamar", "search");
    } else {
      this.recordReady("agil-local", "search");
    }
  }

  recordSearchFailure(providerId: ProviderId, error: unknown): void {
    this.recordDegraded(
      providerId,
      "search",
      providerDegradedReasonFromError(error),
    );
  }

  snapshot(): readonly ProviderStatusSnapshot[] {
    const now = this.#now();
    return Object.freeze(
      PROVIDER_STATUS_DEFINITIONS.map(({ id, label }) => {
        const record = this.#record(id);
        const stale =
          record.observedAtMs !== null &&
          now - record.observedAtMs >= this.#ttlMs;
        return Object.freeze({
          id,
          label,
          configured: record.configured,
          state: stale ? "unknown" : record.state,
          evidence: record.evidence,
          reasonCode: stale ? "stale" : record.reasonCode,
          observedAtMs: record.observedAtMs,
          stale,
        } satisfies ProviderStatusSnapshot);
      }),
    );
  }

  #now(): number {
    const now = this.#clock();
    if (!Number.isFinite(now)) {
      throw new Error("Provider status clock returned an invalid value.");
    }
    return now;
  }

  #record(providerId: ProviderId): ProviderStatusRecord {
    assertProviderId(providerId);
    const record = this.#records.get(providerId);
    if (!record) {
      throw new Error("Unsupported provider status value.");
    }
    return record;
  }

  #configuredRecord(providerId: ProviderId): ProviderStatusRecord {
    const record = this.#record(providerId);
    if (!record.configured) {
      throw new Error("Provider is not configured.");
    }
    return record;
  }

  #shouldKeepFreshSearchEvidence(
    record: ProviderStatusRecord,
    nextEvidence: ProviderStatusEvidence,
    now: number,
  ): boolean {
    return nextEvidence === "prewarm"
      && record.evidence === "search"
      && record.observedAtMs !== null
      && now - record.observedAtMs < this.#ttlMs;
  }
}

export function providerDegradedReasonFromError(
  error: unknown,
): ProviderDegradedReasonCode {
  if (!(error instanceof Error)) {
    return "provider_error";
  }

  const name = error.name.toLowerCase();
  const message = error.message.toLowerCase();
  const summary = `${name} ${message}`;

  if (/\b(?:unexpected token|malformed json|invalid json|json provider payload|html response|html instead of json|parse error)\b/.test(summary)) {
    return "invalid_response";
  }
  if (name === "aborterror" || /\b(?:timed?\s*out|timeout)\b/.test(summary)) {
    return "timeout";
  }
  if (/\b(?:401|403|auth(?:entication|orization)?|credential|login|session|token)\b/.test(summary)) {
    return "authentication_required";
  }
  if (/\b(?:unavailable|network|econnrefused|enotfound|fetch failed|connection refused)\b/.test(summary)) {
    return "provider_unavailable";
  }
  if (/\b(?:invalid|malformed|json|payload|parse|unexpected token|html response)\b/.test(summary)) {
    return "invalid_response";
  }
  return "provider_error";
}

export function providerPublicFailureMessage(
  providerId: ProviderId,
  error: unknown,
): string {
  assertProviderId(providerId);
  if (
    providerId === "agil-local"
    && error instanceof Error
    && error.message.startsWith("Unable to extract Agil session from Chrome profiles.")
  ) {
    return "Unable to extract Agil session from Chrome profiles.";
  }

  const label = PROVIDER_STATUS_DEFINITIONS.find(({ id }) => id === providerId)?.label
    ?? "Provider";
  switch (providerDegradedReasonFromError(error)) {
    case "authentication_required":
      return `${label} authentication or session is unavailable.`;
    case "provider_unavailable":
      return `${label} is temporarily unavailable.`;
    case "timeout":
      return `${label} request timed out.`;
    case "invalid_response":
      return `${label} returned an invalid response.`;
    default:
      return `${label} request failed.`;
  }
}

export function createProviderStatusTracker(
  options: ProviderStatusTrackerOptions = {},
): ProviderStatusTracker {
  return new ProviderStatusTracker(options);
}
