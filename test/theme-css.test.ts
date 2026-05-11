import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("React shell CSS exposes explicit light and dark themes", () => {
  const css = readFileSync(resolve("frontend", "src", "index.css"), "utf8");

  assert.match(css, /:root\s*\{/);
  assert.match(css, /\.dark\s*\{/);
  assert.match(css, /html\.dark/);
  assert.match(css, /\.fd-search-stage/);
  assert.match(css, /\.fd-theme-toggle/);
  assert.match(css, /\.fd-control/);
});
