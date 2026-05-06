import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prewarmLocalCostamarContext,
  resetCostamarWarmupStateForTests,
  setCostamarWarmupGeneratorForTests,
  setCostamarWarmupOpenerForTests,
} from "../src/local-costamar";
import { resetCostamarSessionCacheForTests } from "../src/provider-context";
import { startProviderPrewarmLoop } from "../src/provider-prewarm";

function buildJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value))
    .toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

test("Costamar prewarm resolves context without B2B generator or opener", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-prewarm-"));
  const previousToken = process.env.COSTAMAR_TOKEN;
  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;

  process.env.COSTAMAR_TOKEN = buildJwt({
    id: "0721808110",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = "Profile 1";
  resetCostamarSessionCacheForTests();
  resetCostamarWarmupStateForTests();
  setCostamarWarmupGeneratorForTests(async () => {
    throw new Error("generator should not run");
  });
  setCostamarWarmupOpenerForTests(async () => {
    throw new Error("opener should not run");
  });

  try {
    assert.doesNotThrow(() => prewarmLocalCostamarContext());
  } finally {
    resetCostamarWarmupStateForTests();
    resetCostamarSessionCacheForTests();
    rmSync(tempRoot, { recursive: true, force: true });
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
  }
});

test("provider prewarm loop can be disabled", () => {
  const previous = process.env.FLY_DESK_PROVIDER_PREWARM;
  process.env.FLY_DESK_PROVIDER_PREWARM = "0";
  try {
    assert.equal(startProviderPrewarmLoop(), undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.FLY_DESK_PROVIDER_PREWARM;
    } else {
      process.env.FLY_DESK_PROVIDER_PREWARM = previous;
    }
  }
});
