import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prewarmLocalCostamarContext,
  resetCostamarWarmupStateForTests,
  setCostamarWarmupGeneratorForTests,
  setCostamarWarmupOpenerForTests,
} from "../src/local-costamar";
import {
  resetCostamarSessionCacheForTests,
  resolveLatestCostamarProviderContext,
} from "../src/provider-context";
import {
  describePrewarmFailure,
  providerPrewarmEnabled,
  providerPrewarmIntervalMs,
  startProviderPrewarmLoop,
} from "../src/provider-prewarm";
import type { SearchRequest } from "../src/core/types";
import { applyEnvironment } from "./helpers/environment.ts";
import { removeTempRoot } from "./helpers/temp";

function buildJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value))
    .toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

test("Costamar prewarm resolves context without B2B generator or opener", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-prewarm-"));
  const previousToken = process.env.COSTAMAR_TOKEN;
  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  const previousB2bPrewarm = process.env.COSTAMAR_PROVIDER_B2B_PREWARM_ENABLED;

  process.env.COSTAMAR_TOKEN = buildJwt({
    id: "0721808110",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = "Profile 1";
  process.env.COSTAMAR_PROVIDER_B2B_PREWARM_ENABLED = "1";
  resetCostamarSessionCacheForTests();
  resetCostamarWarmupStateForTests();
  setCostamarWarmupGeneratorForTests(async () => {
    throw new Error("generator should not run");
  });
  setCostamarWarmupOpenerForTests(async () => {
    throw new Error("opener should not run");
  });

  try {
    await assert.doesNotReject(() => prewarmLocalCostamarContext());
  } finally {
    resetCostamarWarmupStateForTests();
    resetCostamarSessionCacheForTests();
    removeTempRoot(tempRoot);
    if (previousToken === undefined) {
      delete process.env.COSTAMAR_TOKEN;
    } else {
      process.env.COSTAMAR_TOKEN = previousToken;
    }
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }
    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }
    if (previousB2bPrewarm === undefined) {
      delete process.env.COSTAMAR_PROVIDER_B2B_PREWARM_ENABLED;
    } else {
      process.env.COSTAMAR_PROVIDER_B2B_PREWARM_ENABLED = previousB2bPrewarm;
    }
  }
});

test("Costamar prewarm refreshes an expired token through the B2B warm-up generator", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-prewarm-refresh-"));
  const previousToken = process.env.COSTAMAR_TOKEN;
  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  const previousCooldown = process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS;
  const previousB2bPrewarm = process.env.COSTAMAR_PROVIDER_B2B_PREWARM_ENABLED;

  const expiredToken = buildJwt({
    id: "0721808110",
    iat: 1700000000,
    exp: 1700003600,
  });
  const freshToken = buildJwt({
    id: "0721808110",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  process.env.COSTAMAR_TOKEN = expiredToken;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = "Profile 2";
  process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS = "0";
  process.env.COSTAMAR_PROVIDER_B2B_PREWARM_ENABLED = "1";
  resetCostamarSessionCacheForTests();
  resetCostamarWarmupStateForTests();

  let warmedRequest: SearchRequest | undefined;
  setCostamarWarmupGeneratorForTests(async (request, context) => {
    warmedRequest = request;
    return {
      ...context,
      token: freshToken,
    };
  });
  setCostamarWarmupOpenerForTests(async () => {
    throw new Error("opener should not run when generator returns a fresh token");
  });

  try {
    await prewarmLocalCostamarContext();

    assert.equal(warmedRequest?.tripType, "round-trip");
    assert.equal(warmedRequest?.searchMode, "exact");
    assert.equal(warmedRequest?.legs[0]?.origin, "LIM");
    assert.equal(warmedRequest?.legs[0]?.destination, "CUZ");
    assert.equal(resolveLatestCostamarProviderContext().token, freshToken);
  } finally {
    resetCostamarWarmupStateForTests();
    resetCostamarSessionCacheForTests();
    removeTempRoot(tempRoot);
    if (previousToken === undefined) {
      delete process.env.COSTAMAR_TOKEN;
    } else {
      process.env.COSTAMAR_TOKEN = previousToken;
    }
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }
    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }
    if (previousCooldown === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS = previousCooldown;
    }
    if (previousB2bPrewarm === undefined) {
      delete process.env.COSTAMAR_PROVIDER_B2B_PREWARM_ENABLED;
    } else {
      process.env.COSTAMAR_PROVIDER_B2B_PREWARM_ENABLED = previousB2bPrewarm;
    }
  }
});

test("provider prewarm loop can be disabled", () => {
  const restoreEnvironment = applyEnvironment({
    FLY_DESK_PROVIDER_PREWARM: "0",
  });
  try {
    assert.equal(startProviderPrewarmLoop(), undefined);
  } finally {
    restoreEnvironment();
  }
});

test("provider prewarm settings use safe defaults and reject invalid intervals", () => {
  const restoreEnvironment = applyEnvironment({
    FLY_DESK_PROVIDER_PREWARM: undefined,
    FLY_DESK_PROVIDER_PREWARM_INTERVAL_MS: "not-a-number",
  });
  try {
    assert.equal(providerPrewarmEnabled(), true);
    assert.equal(providerPrewarmIntervalMs(), 10 * 60 * 1000);
    process.env.FLY_DESK_PROVIDER_PREWARM_INTERVAL_MS = "1234.9";
    assert.equal(providerPrewarmIntervalMs(), 1234);
  } finally {
    restoreEnvironment();
  }
});

test("prewarm failure detail masks credential-like material and stays short", () => {
  /* The old log line said "skipped N provider(s)" and listed only the ids, so a
     provider that had been unreachable for two days left no reason behind. The
     reason is reported now, which means an error message reaches the journal -
     and provider errors carry URLs with tokens in them. */
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjA3MjE4MDgxMTAifQ.c2lnbmF0dXJlLXZhbHVl";
  const masked = describePrewarmFailure(
    new Error(`GET https://provider.example/search?token=${jwt} failed`),
  );
  assert.ok(!masked.includes(jwt), "the token survived into the log line");
  assert.ok(!masked.includes("c2lnbmF0dXJlLXZhbHVl"), "a token segment survived");
  assert.ok(masked.includes("[redacted]"), "nothing was masked at all");
  assert.ok(masked.includes("provider.example"), "the useful part was lost");

  /* The eight-per-segment rule exists so hostnames survive; prove it does. */
  assert.equal(
    describePrewarmFailure(new Error("connect ETIMEDOUT www.agilsmart.com:443")),
    "connect ETIMEDOUT www.agilsmart.com:443",
  );

  const longMessage = describePrewarmFailure(new Error("x".repeat(5_000)));
  assert.ok(longMessage.length <= 200, `detail was ${longMessage.length} chars`);

  assert.equal(describePrewarmFailure(new Error("")), "(no message)");
  assert.equal(
    describePrewarmFailure(new Error("connect  ETIMEDOUT\n  190.12.80.177:443")),
    "connect ETIMEDOUT 190.12.80.177:443",
  );
  assert.equal(describePrewarmFailure("plain string reason"), "plain string reason");
});
