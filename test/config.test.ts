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

test("static app shell responses disable browser caching", async () => {
  await withServer(async (baseUrl) => {
    const [indexResponse, appResponse] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/app.js`),
    ]);

    assert.equal(indexResponse.status, 200);
    assert.equal(appResponse.status, 200);
    assert.equal(indexResponse.headers.get("cache-control"), "no-store");
    assert.equal(appResponse.headers.get("cache-control"), "no-store");
  });
});
