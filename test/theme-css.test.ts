import test from "node:test";
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

test("app.css includes responsive breakpoints for rail and workspace", () => {
  const css = readFileSync(resolve("public", "app.css"), "utf8");

  assert.match(css, /@media\s*\(max-width:\s*1120px\)/);
  assert.match(css, /@media\s*\(max-width:\s*1000px\)/);
  assert.match(css, /@media\s*\(max-width:\s*840px\)/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
});

test("app.css prevents horizontal overflow on html", () => {
  const css = readFileSync(resolve("public", "app.css"), "utf8");

  assert.match(css, /overflow-x:\s*hidden/);
});

test("index.html uses Spanish for initial runtime badge", () => {
  const html = readFileSync(resolve("public", "index.html"), "utf8");

  assert.match(html, /id="runtimeBadge"[^>]*>Listo</);
  assert.doesNotMatch(html, /id="runtimeBadge"[^>]*>IDLE</);
});
