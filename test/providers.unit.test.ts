import { describe, expect, test } from "bun:test";

import {
  configuredSearchProviders,
  normalizeProviderStatusResponse,
  providerStatusCopy,
} from "../frontend/src/lib/providers";

describe("provider status frontend contract", () => {
  test("normalizes only canonical, closed provider status entries", () => {
    const response = normalizeProviderStatusResponse({
      generatedAt: "2026-07-29T12:00:00.000Z",
      staleAfterMs: 300_000,
      providers: [
        {
          id: "agil-local",
          label: "Provider-supplied label is ignored",
          configured: true,
          state: "ready",
          evidence: "search",
          reasonCode: null,
          observedAt: "2026-07-29T11:59:00.000Z",
          stale: false,
          raw: "must not cross the contract",
        },
        {
          id: "costamar",
          label: "Click and Book Plus",
          configured: true,
          state: "degraded",
          evidence: "search",
          reasonCode: "authentication_required",
          observedAt: "2026-07-29T11:58:00.000Z",
          stale: false,
        },
        { id: "unexpected-provider", configured: true, state: "ready" },
      ],
    });

    expect(response).toEqual({
      generatedAt: "2026-07-29T12:00:00.000Z",
      staleAfterMs: 300_000,
      providers: [
        {
          id: "agil-local",
          label: "Agilsmart",
          configured: true,
          state: "ready",
          evidence: "search",
          reasonCode: null,
          observedAt: "2026-07-29T11:59:00.000Z",
          stale: false,
          icon: "/assets/provider-icons/agilsmart-128.png",
        },
        {
          id: "costamar",
          label: "Click and Book Plus",
          configured: true,
          state: "degraded",
          evidence: "search",
          reasonCode: "authentication_required",
          observedAt: "2026-07-29T11:58:00.000Z",
          stale: false,
          icon: "/assets/provider-icons/click-and-book-plus-128.png",
        },
      ],
    });
  });

  test("drops malformed status fields instead of inventing health", () => {
    const response = normalizeProviderStatusResponse({
      generatedAt: "not-a-date",
      staleAfterMs: -1,
      providers: [
        {
          id: "agil-local",
          configured: true,
          state: "healthy",
          evidence: "probe",
          reasonCode: "raw provider failure",
          observedAt: "not-a-date",
          stale: "no",
        },
      ],
    });

    expect(response).toEqual({
      generatedAt: undefined,
      staleAfterMs: undefined,
      providers: [],
    });
  });

  test("maps backend configuration and explicit states to truthful rail copy", () => {
    const providers = configuredSearchProviders([
      {
        id: "agil-local",
        label: "Agilsmart",
        configured: true,
        state: "ready",
        evidence: "prewarm",
        reasonCode: null,
        observedAt: "2026-07-29T12:00:00.000Z",
        stale: false,
        icon: "/assets/provider-icons/agilsmart-128.png",
      },
      {
        id: "costamar",
        label: "Click and Book Plus",
        configured: false,
        state: "unknown",
        evidence: null,
        reasonCode: "not_configured",
        observedAt: null,
        stale: false,
        icon: "/assets/provider-icons/click-and-book-plus-128.png",
      },
    ]);

    expect(providers.map(({ id }) => id)).toEqual(["agil-local"]);
    expect(providerStatusCopy(providers[0])).toBe("disponible");
    expect(providerStatusCopy({
      ...providers[0]!,
      state: "degraded",
      reasonCode: "authentication_required",
    })).toBe("requiere sesión");
    expect(providerStatusCopy({
      ...providers[0]!,
      id: "costamar",
      label: "Click and Book Plus",
      state: "degraded",
      reasonCode: "authentication_required",
    })).toBe("requiere autenticación");
    expect(providerStatusCopy({
      ...providers[0]!,
      state: "unknown",
      reasonCode: "context_only",
    })).toBe("sin verificar");
  });
});
