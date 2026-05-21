import { test } from "bun:test";
import assert from "node:assert/strict";
import { shouldTrustLoopbackClient } from "../src/web-auth";
import { withServer } from "./helpers/server";

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

test("test server defaults loopback trust only inside the harness", { concurrency: false }, async () => {
  const previous = process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;

  try {
    delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/locations?q=`);
      assert.equal(response.status, 200);
    });

    assert.equal(process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT, undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
    } else {
      process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = previous;
    }
  }
});

test("test server preserves explicit loopback trust opt-out", { concurrency: false }, async () => {
  const previous = process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;

  try {
    process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "0";

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/locations?q=`);
      assert.equal(response.status, 403);
    });

    assert.equal(process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT, "0");
  } finally {
    if (previous === undefined) {
      delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
    } else {
      process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = previous;
    }
  }
});
