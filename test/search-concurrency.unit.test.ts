import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  SHARED_SEARCH_CONCURRENCY,
  resolveMatrixCellConcurrency,
  resolveProviderSubrequestConcurrency,
  resolveRangeSearchConcurrency,
} from "../src/search-concurrency";
import { AGIL_CONCURRENCY } from "../src/local-agil";

function withEnv<T>(overrides: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("shared caps keep provider overrides from exceeding the default concurrency budget", () => {
  withEnv({
    SEARCH_PROVIDER_SUBREQUEST_CONCURRENCY: undefined,
    SEARCH_MATRIX_CELL_CONCURRENCY: undefined,
    SEARCH_RANGE_SEARCH_CONCURRENCY: undefined,
    AGIL_GDS_SEARCH_CONCURRENCY: "12",
    AGIL_MATRIX_CELL_CONCURRENCY: "12",
    AGIL_RANGE_SEARCH_CONCURRENCY: "9",
  }, () => {
    assert.equal(resolveProviderSubrequestConcurrency("AGIL_GDS_SEARCH_CONCURRENCY", 7), 7);
    assert.equal(resolveMatrixCellConcurrency("AGIL_MATRIX_CELL_CONCURRENCY"), 6);
    assert.equal(resolveRangeSearchConcurrency("AGIL_RANGE_SEARCH_CONCURRENCY"), 2);
  });
});

test("the default subrequest budget covers the full Agil GDS list in a single wave", () => {
  withEnv({
    SEARCH_PROVIDER_SUBREQUEST_CONCURRENCY: undefined,
    AGIL_GDS_SEARCH_CONCURRENCY: undefined,
  }, () => {
    assert.equal(SHARED_SEARCH_CONCURRENCY.providerSubrequestDefault, 7);
    assert.equal(resolveProviderSubrequestConcurrency("AGIL_GDS_SEARCH_CONCURRENCY", 7), 7);
    assert.equal(AGIL_CONCURRENCY.gdsSearch, 7);
  });
});

test("the Agil provider env still restores the previous two-wave fan-out", () => {
  withEnv({
    SEARCH_PROVIDER_SUBREQUEST_CONCURRENCY: undefined,
    AGIL_GDS_SEARCH_CONCURRENCY: "4",
  }, () => {
    assert.equal(AGIL_CONCURRENCY.gdsSearch, 4);
  });
});

test("shared caps can be raised explicitly when a machine can handle more work", () => {
  withEnv({
    SEARCH_PROVIDER_SUBREQUEST_CONCURRENCY: "10",
    SEARCH_MATRIX_CELL_CONCURRENCY: "9",
    SEARCH_RANGE_SEARCH_CONCURRENCY: "5",
    AGIL_GDS_SEARCH_CONCURRENCY: "12",
    AGIL_MATRIX_CELL_CONCURRENCY: "12",
    AGIL_RANGE_SEARCH_CONCURRENCY: "9",
  }, () => {
    assert.equal(resolveProviderSubrequestConcurrency("AGIL_GDS_SEARCH_CONCURRENCY", 7), 10);
    assert.equal(resolveMatrixCellConcurrency("AGIL_MATRIX_CELL_CONCURRENCY"), 9);
    assert.equal(resolveRangeSearchConcurrency("AGIL_RANGE_SEARCH_CONCURRENCY"), 5);
  });
});

test("provider concurrency can read a preferred env name before a legacy fallback", () => {
  withEnv({
    SEARCH_PROVIDER_SUBREQUEST_CONCURRENCY: "10",
    SEARCH_MATRIX_CELL_CONCURRENCY: "10",
    SEARCH_RANGE_SEARCH_CONCURRENCY: "10",
    CBPLUS_GDS_SEARCH_CONCURRENCY: "8",
    COSTAMAR_GDS_SEARCH_CONCURRENCY: "3",
    CBPLUS_MATRIX_CELL_CONCURRENCY: "7",
    COSTAMAR_MATRIX_CELL_CONCURRENCY: "4",
    CBPLUS_RANGE_SEARCH_CONCURRENCY: undefined,
    COSTAMAR_RANGE_SEARCH_CONCURRENCY: "6",
  }, () => {
    assert.equal(
      resolveProviderSubrequestConcurrency(["CBPLUS_GDS_SEARCH_CONCURRENCY", "COSTAMAR_GDS_SEARCH_CONCURRENCY"], 4),
      8,
    );
    assert.equal(
      resolveMatrixCellConcurrency(["CBPLUS_MATRIX_CELL_CONCURRENCY", "COSTAMAR_MATRIX_CELL_CONCURRENCY"]),
      7,
    );
    assert.equal(
      resolveRangeSearchConcurrency(["CBPLUS_RANGE_SEARCH_CONCURRENCY", "COSTAMAR_RANGE_SEARCH_CONCURRENCY"]),
      6,
    );
  });
});
