import { expect, test } from "bun:test";
import { applyEnvironment } from "./helpers/environment.ts";

test("applyEnvironment restores existing and missing variables", () => {
  const existingName = "FLY_DESK_TEST_EXISTING_ENV";
  const missingName = "FLY_DESK_TEST_MISSING_ENV";
  process.env[existingName] = "before";
  delete process.env[missingName];

  const restore = applyEnvironment({
    [existingName]: "during",
    [missingName]: "created",
  });

  expect(process.env[existingName]).toBe("during");
  expect(process.env[missingName]).toBe("created");

  restore();

  expect(process.env[existingName]).toBe("before");
  expect(process.env[missingName]).toBeUndefined();
  delete process.env[existingName];
});
