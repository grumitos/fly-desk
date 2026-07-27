import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as exchangeRate from "../src/quotation-exchange-rate";
import { buildOffer } from "./helpers/ui-fixtures";

test("resolveStandaloneUsdToPenRate uses the selected offer rate before an external lookup", async () => {
  exchangeRate.resetQuotationUsdToPenRateCacheForTests();
  let externalCalls = 0;

  const rate = await exchangeRate.resolveStandaloneUsdToPenRate(buildOffer({
    usdToPenRate: 3.62,
  }), {
    now: new Date("2026-04-07T15:00:00.000Z"),
    fetchExternalRate: async () => {
      externalCalls += 1;
      return 3.517;
    },
  });

  assert.equal(rate, 3.62);
  assert.equal(externalCalls, 0);
});

test("resolveStandaloneUsdToPenRate resolves PEN to USD quotation conversion", async () => {
  exchangeRate.resetQuotationUsdToPenRateCacheForTests();
  let externalCalls = 0;

  const rate = await exchangeRate.resolveStandaloneUsdToPenRate(buildOffer({
    price: {
      total: {
        amount: 4_500,
        currencyCode: "PEN",
      },
    },
    usdToPenRate: undefined,
  }), {
    now: new Date("2026-04-08T15:00:00.000Z"),
    fetchExternalRate: async () => {
      externalCalls += 1;
      return 3.61;
    },
  });

  assert.equal(rate, 3.61);
  assert.equal(externalCalls, 1);
});

test("fetchExternalUsdToPenRate reads SUNAT daily rate payloads", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.FLY_DESK_QUOTATION_RATE_URL;
  process.env.FLY_DESK_QUOTATION_RATE_URL = "https://example.test/tipo-cambio.json";
  let fetchCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetchCalls += 1;
    assert.equal(String(url), "https://example.test/tipo-cambio.json");
    return new Response(JSON.stringify({
      fecha: "2026-05-05",
      sunat: 3.517,
      compra: 3.512,
      venta: 3.522,
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }) as typeof fetch;

  try {
    assert.deepEqual(await exchangeRate.fetchExternalUsdToPenRateInfo(), {
      rate: 3.517,
      sourceLabel: "SUNAT",
      date: "2026-05-05",
    });
    assert.equal(await exchangeRate.fetchExternalUsdToPenRate(), 3.517);
    assert.equal(fetchCalls, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) {
      delete process.env.FLY_DESK_QUOTATION_RATE_URL;
    } else {
      process.env.FLY_DESK_QUOTATION_RATE_URL = previousUrl;
    }
  }
});

test("fetchExternalUsdToPenRateInfo aborts a stalled SUNAT request at the app timeout", async () => {
  let aborted = false;
  const keepEventLoopAlive = setTimeout(() => undefined, 100);
  const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal);
    signal.addEventListener("abort", () => {
      aborted = true;
      reject(signal.reason);
    }, { once: true });
  })) as typeof fetch;

  try {
    const rateInfo = await exchangeRate.fetchExternalUsdToPenRateInfo({
      fetchImpl,
      timeoutMs: 5,
    });

    assert.equal(rateInfo, undefined);
    assert.equal(aborted, true);
  } finally {
    clearTimeout(keepEventLoopAlive);
  }
});

test("standalone rate lookup ignores the legacy predictable tmp cache path", async () => {
  const previousCachePath = process.env.FLY_DESK_QUOTATION_RATE_CACHE_PATH;
  delete process.env.FLY_DESK_QUOTATION_RATE_CACHE_PATH;
  const legacyTmpCachePath = join(tmpdir(), "flydesk-quotation-usd-pen-rate.json");
  exchangeRate.resetQuotationUsdToPenRateCacheForTests();
  writeFileSync(legacyTmpCachePath, JSON.stringify({
    day: "2026-04-07",
    rate: 7.6543,
  }), "utf8");

  try {
    let lookupCalls = 0;
    const rate = await exchangeRate.resolveStandaloneUsdToPenRate(buildOffer({
      usdToPenRate: undefined,
    }), {
      now: new Date("2026-04-07T15:00:00.000Z"),
      fetchExternalRate: async () => {
        lookupCalls += 1;
        return 3.6123;
      },
    });

    assert.equal(rate, 3.6123);
    assert.equal(lookupCalls, 1);
  } finally {
    rmSync(legacyTmpCachePath, { force: true });
    exchangeRate.resetQuotationUsdToPenRateCacheForTests();
    if (previousCachePath === undefined) {
      delete process.env.FLY_DESK_QUOTATION_RATE_CACHE_PATH;
    } else {
      process.env.FLY_DESK_QUOTATION_RATE_CACHE_PATH = previousCachePath;
    }
  }
});

test("standalone rate lookup restores the same-day cache after a process-like reset", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-quotation-rate-cache-"));
  const previousCachePath = process.env.FLY_DESK_QUOTATION_RATE_CACHE_PATH;
  process.env.FLY_DESK_QUOTATION_RATE_CACHE_PATH = join(tempRoot, "usd-pen-rate.json");

  try {
    exchangeRate.resetQuotationUsdToPenRateCacheForTests();
    const offer = buildOffer({ usdToPenRate: undefined });
    let lookupCalls = 0;
    const fetchExternalRate = async () => {
      lookupCalls += 1;
      return lookupCalls === 1 ? 3.64 : 3.7;
    };

    const firstRate = await exchangeRate.resolveStandaloneUsdToPenRate(offer, {
      now: new Date("2026-04-07T15:00:00.000Z"),
      fetchExternalRate,
    });
    exchangeRate.resetQuotationUsdToPenRateCacheForTests({ preservePersisted: true });
    const secondRate = await exchangeRate.resolveStandaloneUsdToPenRate(offer, {
      now: new Date("2026-04-07T18:00:00.000Z"),
      fetchExternalRate,
    });

    assert.equal(firstRate, 3.64);
    assert.equal(secondRate, 3.64);
    assert.equal(lookupCalls, 1);
  } finally {
    exchangeRate.resetQuotationUsdToPenRateCacheForTests();
    if (previousCachePath === undefined) {
      delete process.env.FLY_DESK_QUOTATION_RATE_CACHE_PATH;
    } else {
      process.env.FLY_DESK_QUOTATION_RATE_CACHE_PATH = previousCachePath;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
