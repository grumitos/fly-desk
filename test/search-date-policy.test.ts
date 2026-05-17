import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  addDaysIso,
  getSearchDatePolicy,
  isIsoDateString,
  validateSearchDateInPolicy,
} from "../src/search-date-policy";

test("getSearchDatePolicy uses a rolling 365-day window by default", () => {
  const policy = getSearchDatePolicy(new Date("2026-03-31T12:00:00.000Z"));

  assert.equal(policy.minSearchDate, "2026-03-31");
  assert.equal(policy.maxSearchDate, "2027-03-31");
  assert.equal(policy.maxFutureDays, 365);
});

test("validateSearchDateInPolicy accepts 2027-01-01 when today is 2026-03-31", () => {
  const policy = getSearchDatePolicy(new Date("2026-03-31T12:00:00.000Z"));

  assert.deepEqual(validateSearchDateInPolicy("Departure date", "2027-01-01", policy), []);
});

test("validateSearchDateInPolicy rejects impossible calendar dates without rollover", () => {
  const policy = getSearchDatePolicy(new Date("2026-03-31T12:00:00.000Z"));

  assert.equal(isIsoDateString("2026-06-31"), false);
  assert.deepEqual(
    validateSearchDateInPolicy("Departure date", "2026-06-31", policy),
    ["Departure date must be a valid ISO date (YYYY-MM-DD)."],
  );
});

test("validateSearchDateInPolicy rejects dates outside the rolling window", () => {
  const policy = getSearchDatePolicy(new Date("2026-03-31T12:00:00.000Z"));
  const outside = addDaysIso(policy.maxSearchDate, 1);

  assert.deepEqual(
    validateSearchDateInPolicy("Departure date", outside, policy),
    [`Departure date must be on or before ${policy.maxSearchDate}.`],
  );
});
