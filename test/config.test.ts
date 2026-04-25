import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SERVER_HOST, resolveServerHost } from "../src/config";
import { withServer } from "./helpers/server";

test("resolveServerHost binds to loopback by default", () => {
  const previous = process.env.HOST;
  delete process.env.HOST;

  try {
    assert.equal(resolveServerHost(), DEFAULT_SERVER_HOST);
  } finally {
    if (previous === undefined) {
      delete process.env.HOST;
    } else {
      process.env.HOST = previous;
    }
  }
});

test("resolveServerHost honors an explicit HOST override", () => {
  const previous = process.env.HOST;
  process.env.HOST = "0.0.0.0";

  try {
    assert.equal(resolveServerHost(), "0.0.0.0");
  } finally {
    if (previous === undefined) {
      delete process.env.HOST;
    } else {
      process.env.HOST = previous;
    }
  }
});

test("static app shell responses disable browser caching and include hardening headers", async () => {
  await withServer(async (baseUrl) => {
    const indexResponse = await fetch(`${baseUrl}/`);

    assert.equal(indexResponse.status, 200);
    assert.equal(indexResponse.headers.get("cache-control"), "no-store");
    assert.match(indexResponse.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal(indexResponse.headers.get("x-content-type-options"), "nosniff");
    assert.equal(indexResponse.headers.get("x-frame-options"), "DENY");
    assert.equal(indexResponse.headers.get("referrer-policy"), "no-referrer");
  });
});

test("invalid JSON payloads return a client error without parser details", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    const payload = await response.json() as { error?: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Invalid JSON payload.");
  });
});
