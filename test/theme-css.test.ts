import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("app.css exposes explicit light and dark themes with system fallback", () => {
  const css = readFileSync(resolve("public", "app.css"), "utf8");

  assert.match(css, /html\[data-theme="light"\]/);
  assert.match(css, /html\[data-theme="dark"\]/);
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.match(css, /\.search-rail/);
  assert.match(css, /#calendarPopover/);
  assert.match(css, /\.theme-switch/);
});
