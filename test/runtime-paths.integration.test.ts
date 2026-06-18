import { test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resolvePersistPath } from "../src/runtime-paths";

test("resolvePersistPath uses FLY_DESK_APP_DATA_DIR before the release-local cache", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAppDataDir = process.env.FLY_DESK_APP_DATA_DIR;
  const previousSpecificPath = process.env.FLY_DESK_LOCATION_USAGE_DB_PATH;

  delete process.env.NODE_ENV;
  process.env.FLY_DESK_APP_DATA_DIR = "D:\\fly-desk-data";
  delete process.env.FLY_DESK_LOCATION_USAGE_DB_PATH;

  try {
    assert.equal(
      resolvePersistPath("FLY_DESK_LOCATION_USAGE_DB_PATH", "location-usage.sqlite"),
      join("D:\\fly-desk-data", "location-usage.sqlite"),
    );
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }

    if (previousAppDataDir === undefined) {
      delete process.env.FLY_DESK_APP_DATA_DIR;
    } else {
      process.env.FLY_DESK_APP_DATA_DIR = previousAppDataDir;
    }

    if (previousSpecificPath === undefined) {
      delete process.env.FLY_DESK_LOCATION_USAGE_DB_PATH;
    } else {
      process.env.FLY_DESK_LOCATION_USAGE_DB_PATH = previousSpecificPath;
    }
  }
});

test("resolvePersistPath still lets specific cache paths override FLY_DESK_APP_DATA_DIR", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAppDataDir = process.env.FLY_DESK_APP_DATA_DIR;
  const previousSpecificPath = process.env.FLY_DESK_LOCATION_USAGE_DB_PATH;

  delete process.env.NODE_ENV;
  process.env.FLY_DESK_APP_DATA_DIR = "D:\\fly-desk-data";
  process.env.FLY_DESK_LOCATION_USAGE_DB_PATH = "D:\\custom\\usage.sqlite";

  try {
    assert.equal(
      resolvePersistPath("FLY_DESK_LOCATION_USAGE_DB_PATH", "location-usage.sqlite"),
      "D:\\custom\\usage.sqlite",
    );
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }

    if (previousAppDataDir === undefined) {
      delete process.env.FLY_DESK_APP_DATA_DIR;
    } else {
      process.env.FLY_DESK_APP_DATA_DIR = previousAppDataDir;
    }

    if (previousSpecificPath === undefined) {
      delete process.env.FLY_DESK_LOCATION_USAGE_DB_PATH;
    } else {
      process.env.FLY_DESK_LOCATION_USAGE_DB_PATH = previousSpecificPath;
    }
  }
});
