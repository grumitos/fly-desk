import { describe, expect, test } from "bun:test";

import {
  PROVIDER_STATUS_DEFINITIONS,
  PROVIDER_STATUS_REASON_CODES,
  createProviderStatusTracker,
  providerDegradedReasonFromError,
  providerPublicFailureMessage,
  type ProviderStatusEvidence,
  type ProviderStatusReasonCode,
} from "../src/provider-status";

describe("provider status tracker", () => {
  test("starts from canonical, configured providers without claiming availability", () => {
    const tracker = createProviderStatusTracker({
      clock: () => 1_000,
      ttlMs: 100,
    });

    expect(PROVIDER_STATUS_DEFINITIONS).toEqual([
      { id: "agil-local", label: "Agilsmart" },
      { id: "costamar", label: "Click and Book Plus" },
    ]);
    expect(tracker.snapshot()).toEqual([
      {
        id: "agil-local",
        label: "Agilsmart",
        configured: true,
        state: "unknown",
        evidence: null,
        reasonCode: "not_checked",
        observedAtMs: null,
        stale: false,
      },
      {
        id: "costamar",
        label: "Click and Book Plus",
        configured: true,
        state: "unknown",
        evidence: null,
        reasonCode: "not_checked",
        observedAtMs: null,
        stale: false,
      },
    ]);
  });

  test("tracks configured providers explicitly", () => {
    const tracker = createProviderStatusTracker({
      clock: () => 1_000,
      configuredProviderIds: ["agil-local"],
    });

    expect(tracker.snapshot()[1]).toEqual({
      id: "costamar",
      label: "Click and Book Plus",
      configured: false,
      state: "unknown",
      evidence: null,
      reasonCode: "not_configured",
      observedAtMs: null,
      stale: false,
    });
    expect(() => tracker.markChecking("costamar", "prewarm")).toThrow(
      "Provider is not configured.",
    );
  });

  test("updates one provider without rewriting the other provider state", () => {
    let now = 2_000;
    const tracker = createProviderStatusTracker({ clock: () => now });

    tracker.markChecking("agil-local", "prewarm");
    expect(tracker.snapshot().map(({ id, state }) => ({ id, state }))).toEqual([
      { id: "agil-local", state: "checking" },
      { id: "costamar", state: "unknown" },
    ]);

    now = 2_010;
    tracker.recordReady("agil-local", "prewarm");
    now = 2_020;
    tracker.recordDegraded("costamar", "search", "timeout");

    expect(tracker.snapshot().map(({ id, state, evidence, reasonCode }) => ({
      id,
      state,
      evidence,
      reasonCode,
    }))).toEqual([
      {
        id: "agil-local",
        state: "ready",
        evidence: "prewarm",
        reasonCode: null,
      },
      {
        id: "costamar",
        state: "degraded",
        evidence: "search",
        reasonCode: "timeout",
      },
    ]);
  });

  test("expires observations to an explicit stale unknown state", () => {
    let now = 10_000;
    const tracker = createProviderStatusTracker({
      clock: () => now,
      ttlMs: 100,
    });

    tracker.recordReady("agil-local", "search");
    now = 10_099;
    expect(tracker.snapshot()[0]).toMatchObject({
      state: "ready",
      reasonCode: null,
      stale: false,
    });

    now = 10_100;
    expect(tracker.snapshot()[0]).toMatchObject({
      state: "unknown",
      evidence: "search",
      reasonCode: "stale",
      observedAtMs: 10_000,
      stale: true,
    });
    expect(tracker.snapshot()[1]).toMatchObject({
      state: "unknown",
      reasonCode: "not_checked",
      stale: false,
    });
  });

  test("never treats Costamar context-only prewarm as provider readiness", () => {
    let now = 20_000;
    const tracker = createProviderStatusTracker({ clock: () => now });

    tracker.markChecking("costamar", "prewarm");
    now = 20_010;
    tracker.recordCostamarContextAvailable();

    expect(tracker.snapshot()[1]).toMatchObject({
      state: "unknown",
      evidence: "prewarm",
      reasonCode: "context_only",
      observedAtMs: 20_010,
      stale: false,
    });

    const unsafeReady = tracker.recordReady.bind(tracker) as (
      providerId: string,
      evidence: string,
    ) => void;
    expect(() => unsafeReady("costamar", "prewarm")).toThrow(
      "Costamar prewarm only verifies local context.",
    );
    expect(tracker.snapshot()[1].state).toBe("unknown");

    now = 20_020;
    tracker.recordReady("costamar", "search");
    expect(tracker.snapshot()[1]).toMatchObject({
      state: "ready",
      evidence: "search",
      reasonCode: null,
    });
  });

  test("does not let lower-confidence prewarm overwrite a fresh search observation", () => {
    let now = 25_000;
    const tracker = createProviderStatusTracker({ clock: () => now, ttlMs: 100 });

    tracker.recordReady("costamar", "search");
    now = 25_010;
    tracker.markChecking("costamar", "prewarm");
    tracker.recordCostamarContextAvailable();
    tracker.recordDegraded("costamar", "prewarm", "provider_error");

    expect(tracker.snapshot()[1]).toMatchObject({
      state: "ready",
      evidence: "search",
      reasonCode: null,
      observedAtMs: 25_000,
    });

    now = 25_100;
    tracker.markChecking("costamar", "prewarm");
    expect(tracker.snapshot()[1]).toMatchObject({
      state: "checking",
      evidence: "prewarm",
      reasonCode: "check_in_progress",
      observedAtMs: 25_100,
    });
  });

  test("records successful and failed search outcomes through closed status values", () => {
    const tracker = createProviderStatusTracker({ clock: () => 27_000 });

    tracker.recordSearchResult("agil-local", false);
    tracker.recordSearchResult("costamar", true);
    expect(tracker.snapshot().map(({ state, reasonCode }) => ({ state, reasonCode }))).toEqual([
      { state: "ready", reasonCode: null },
      { state: "degraded", reasonCode: "partial_results" },
    ]);

    tracker.recordSearchFailure(
      "agil-local",
      new Error("provider request carried token=never-expose-this-secret and timed out"),
    );
    expect(tracker.snapshot()[0]).toMatchObject({
      state: "degraded",
      evidence: "search",
      reasonCode: "timeout",
    });
    expect(JSON.stringify(tracker.snapshot())).not.toContain("never-expose-this-secret");
  });

  test("classifies provider failures without returning provider messages", () => {
    const cases = [
      [Object.assign(new Error("cancelled"), { name: "AbortError" }), "timeout"],
      [new Error("request timeout after 20 seconds"), "timeout"],
      [new Error("HTTP 401 authentication token expired"), "authentication_required"],
      [new TypeError("fetch failed: ECONNREFUSED"), "provider_unavailable"],
      [new Error("invalid JSON provider payload"), "invalid_response"],
      [new SyntaxError("Unexpected token '<': provider returned HTML instead of JSON"), "invalid_response"],
      [new Error("unexpected provider failure"), "provider_error"],
      ["opaque rejection", "provider_error"],
    ] as const;

    for (const [error, expected] of cases) {
      expect(providerDegradedReasonFromError(error)).toBe(expected);
    }
  });

  test("renders provider failures through closed public messages", () => {
    expect(providerPublicFailureMessage(
      "agil-local",
      new Error("request token=never-expose-this-secret timed out at https://provider.invalid/private"),
    )).toBe("Agilsmart request timed out.");
    expect(providerPublicFailureMessage(
      "agil-local",
      new Error("Unable to extract Agil session from Chrome profiles. Default: private path"),
    )).toBe("Unable to extract Agil session from Chrome profiles.");
    expect(providerPublicFailureMessage(
      "costamar",
      new Error("HTTP 401 token=never-expose-this-secret"),
    )).toBe("Click and Book Plus authentication or session is unavailable.");

    const messages = [
      providerPublicFailureMessage("costamar", new TypeError("fetch failed: ECONNREFUSED private-host")),
      providerPublicFailureMessage("costamar", new Error("malformed JSON: private payload")),
      providerPublicFailureMessage("costamar", new Error("unexpected private failure")),
    ];
    expect(messages).toEqual([
      "Click and Book Plus is temporarily unavailable.",
      "Click and Book Plus returned an invalid response.",
      "Click and Book Plus request failed.",
    ]);
    expect(messages.join(" ")).not.toContain("private");
  });

  test("accepts only closed reason codes and exposes no diagnostic payload fields", () => {
    const tracker = createProviderStatusTracker({ clock: () => 30_000 });

    expect(PROVIDER_STATUS_REASON_CODES).toEqual([
      "not_configured",
      "not_checked",
      "check_in_progress",
      "context_only",
      "stale",
      "authentication_required",
      "provider_unavailable",
      "timeout",
      "invalid_response",
      "partial_results",
      "provider_error",
    ]);

    const unsafeDegraded = tracker.recordDegraded.bind(tracker) as (
      providerId: string,
      evidence: ProviderStatusEvidence,
      reasonCode: ProviderStatusReasonCode,
    ) => void;
    expect(() =>
      unsafeDegraded(
        "agil-local",
        "search",
        "https://provider.invalid/?token=secret" as ProviderStatusReasonCode,
      ),
    ).toThrow("Unsupported provider status reason code.");

    tracker.recordDegraded("agil-local", "search", "provider_error");
    const snapshot = tracker.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(Object.keys(snapshot[0])).toEqual([
      "id",
      "label",
      "configured",
      "state",
      "evidence",
      "reasonCode",
      "observedAtMs",
      "stale",
    ]);

    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [
      "raw",
      "detail",
      '"error":',
      "token",
      "terminal",
      "url",
      "secret",
      "provider.invalid",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });
});
