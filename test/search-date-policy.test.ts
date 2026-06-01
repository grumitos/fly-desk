import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  addDaysIso,
  getSearchDatePolicy,
  isIsoDateString,
  resolveMigrationConcurrentMonths,
  resolveSearchTodayIso,
  validateSearchDateInPolicy,
} from "../src/search-date-policy";

function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

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

test("SEARCH_TODAY_OVERRIDE is honored only in test mode", () => {
  assert.equal(
    withEnv({ NODE_ENV: "test", SEARCH_TODAY_OVERRIDE: "2026-03-31" }, () =>
      resolveSearchTodayIso(new Date("2026-05-21T12:00:00.000Z"))),
    "2026-03-31",
  );

  assert.equal(
    withEnv({ NODE_ENV: "production", SEARCH_TODAY_OVERRIDE: "2026-03-31" }, () =>
      resolveSearchTodayIso(new Date("2026-05-21T12:00:00.000Z"))),
    "2026-05-21",
  );
});

test("migration monthly concurrency defaults to four and stays bounded", () => {
  assert.equal(
    withEnv({ FLY_DESK_MIGRATION_CONCURRENT_MONTHS: undefined }, resolveMigrationConcurrentMonths),
    4,
  );
  assert.equal(
    withEnv({ FLY_DESK_MIGRATION_CONCURRENT_MONTHS: "8" }, resolveMigrationConcurrentMonths),
    8,
  );
  assert.equal(
    withEnv({ FLY_DESK_MIGRATION_CONCURRENT_MONTHS: "0" }, resolveMigrationConcurrentMonths),
    1,
  );
  assert.equal(
    withEnv({ FLY_DESK_MIGRATION_CONCURRENT_MONTHS: "99" }, resolveMigrationConcurrentMonths),
    12,
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
