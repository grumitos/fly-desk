import { test } from "bun:test";
import assert from "node:assert/strict";
import { shouldTrustLoopbackClient } from "../src/web-auth";

test("loopback trust is disabled by default and enabled only when explicitly set", () => {
  const previous = process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;

  try {
    delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
    assert.equal(shouldTrustLoopbackClient(), false);

    process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "1";
    assert.equal(shouldTrustLoopbackClient(), true);

    process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "0";
    assert.equal(shouldTrustLoopbackClient(), false);

    process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "yes";
    assert.equal(shouldTrustLoopbackClient(), false);
  } finally {
    if (previous === undefined) {
      delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
    } else {
      process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = previous;
    }
  }
});
