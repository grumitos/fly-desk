import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolveServerIdleTimeoutSeconds } from "../src/server";

test("server idle timeout defaults above Bun's short request timeout", () => {
  assert.equal(resolveServerIdleTimeoutSeconds(undefined), 120);
  assert.equal(resolveServerIdleTimeoutSeconds("not-a-number"), 120);
  assert.equal(resolveServerIdleTimeoutSeconds("999"), 255);
  assert.equal(resolveServerIdleTimeoutSeconds("0"), 0);
  assert.equal(resolveServerIdleTimeoutSeconds("45"), 45);
});
