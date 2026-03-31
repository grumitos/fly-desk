import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProviderContext,
  DEFAULT_COSTAMAR_API_BASE_URL,
  DEFAULT_COSTAMAR_BRAND_BASE_URL,
  DEFAULT_COSTAMAR_TERMINAL_ID,
  normalizeCostamarProviderContext,
} from "../src/provider-context";
import type { ProviderConfigInput } from "../src/core/types";

test("buildProviderContext ignores request-scoped Costamar base urls", () => {
  const context = buildProviderContext("costamar", {
    costamar: {
      terminalId: "0721808110",
      token: "super-secret-token",
      lang: "es",
      apiBaseUrl: "https://malicious.example/internal",
      brandBaseUrl: "https://evil.example/redirect",
    },
  } as unknown as ProviderConfigInput);

  assert.equal(context?.costamar?.apiBaseUrl, DEFAULT_COSTAMAR_API_BASE_URL);
  assert.equal(context?.costamar?.brandBaseUrl, DEFAULT_COSTAMAR_BRAND_BASE_URL);
  assert.equal(context?.costamar?.terminalId, "0721808110");
  assert.equal(context?.costamar?.token, "super-secret-token");
  assert.equal(context?.costamar?.lang, "es");
});

test("normalizeCostamarProviderContext rejects unapproved api hosts from env", () => {
  const previous = process.env.COSTAMAR_API_BASE_URL;
  process.env.COSTAMAR_API_BASE_URL = "https://example.com/vuelos/api";

  try {
    assert.throws(
      () => normalizeCostamarProviderContext(),
      /COSTAMAR_API_BASE_URL must use https and an approved host\./,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.COSTAMAR_API_BASE_URL;
    } else {
      process.env.COSTAMAR_API_BASE_URL = previous;
    }
  }
});

test("normalizeCostamarProviderContext rejects non-https brand urls from env", () => {
  const previous = process.env.COSTAMAR_BRAND_BASE_URL;
  process.env.COSTAMAR_BRAND_BASE_URL = "http://booking.clickandbook.com/vuelos";

  try {
    assert.throws(
      () => normalizeCostamarProviderContext(),
      /COSTAMAR_BRAND_BASE_URL must use https and an approved host\./,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.COSTAMAR_BRAND_BASE_URL;
    } else {
      process.env.COSTAMAR_BRAND_BASE_URL = previous;
    }
  }
});

test("normalizeCostamarProviderContext falls back to the default Costamar terminal", () => {
  const previous = process.env.COSTAMAR_TERMINAL_ID;
  delete process.env.COSTAMAR_TERMINAL_ID;

  try {
    const context = normalizeCostamarProviderContext();
    assert.equal(context.terminalId, DEFAULT_COSTAMAR_TERMINAL_ID);
  } finally {
    if (previous === undefined) {
      delete process.env.COSTAMAR_TERMINAL_ID;
    } else {
      process.env.COSTAMAR_TERMINAL_ID = previous;
    }
  }
});
