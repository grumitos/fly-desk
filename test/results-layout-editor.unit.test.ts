import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  isLocalResultsLayoutHost,
  resultsLayoutEditorEnabledFromUrl,
  resultsLayoutPersistenceEnabled,
} from "../frontend/src/lib/results-layout-editor";

test("results layout editor is only enabled on localhost URLs", () => {
  assert.equal(resultsLayoutEditorEnabledFromUrl("http://127.0.0.1:8100/?layout=editor"), true);
  assert.equal(resultsLayoutEditorEnabledFromUrl("http://localhost:8100/?layoutEditor=1"), true);
  assert.equal(resultsLayoutEditorEnabledFromUrl("https://fly-desk.pages.dev/?layout=editor"), false);
  assert.equal(resultsLayoutEditorEnabledFromUrl("http://127.0.0.1:8100/?layout=off"), false);
});

test("results layout persistence is only available for local browser hosts", () => {
  assert.equal(isLocalResultsLayoutHost("127.0.0.1"), true);
  assert.equal(isLocalResultsLayoutHost("localhost"), true);
  assert.equal(isLocalResultsLayoutHost("fly-desk.pages.dev"), false);
  assert.equal(resultsLayoutPersistenceEnabled("fly-desk.pages.dev"), false);
});
