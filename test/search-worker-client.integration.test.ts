import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchRequest } from "../src/core/types";
import {
  prewarmProviderInWorker,
  resolveSearchWorkerBunExecutableForTests,
  runProviderSearchInWorker,
  searchWorkerPoolPidForTests,
  stopSearchWorkerPool,
} from "../src/search-worker-client";
import { removeTempRoot } from "./helpers/temp";

const ENV_KEYS = [
  "AGIL_BROWSER_URL",
  "AGIL_BROWSER_WS_ENDPOINT",
  "AGIL_CHROME_PROFILE",
  "AGIL_CHROME_USER_DATA_DIR",
  "AGIL_CHROME_PROCESS_DISCOVERY",
  "AGIL_TEMP_CHROME_STORAGE_FALLBACK",
  "BUN_EXECUTABLE_PATH",
  "CHROME_USER_DATA_DIR",
  "COSTAMAR_CHROME_USER_DATA_DIR",
  "FLY_DESK_SEARCH_WORKER_POOL",
  "FLY_DESK_SEARCH_WORKER_PROCESSES",
  "LOCALAPPDATA",
] as const;

function createEmptyChromeProfile(prefix: string): { tempRoot: string; chromeUserDataDir: string } {
  const tempRoot = mkdtempSync(join(tmpdir(), prefix));
  const chromeUserDataDir = join(tempRoot, "Google", "Chrome", "User Data");
  mkdirSync(join(chromeUserDataDir, "Default"), { recursive: true });
  return { tempRoot, chromeUserDataDir };
}

function emptyProfileEnv(
  chromeUserDataDir: string,
  tempRoot: string,
): Partial<Record<typeof ENV_KEYS[number], string | undefined>> {
  return {
    AGIL_BROWSER_URL: undefined,
    AGIL_BROWSER_WS_ENDPOINT: undefined,
    AGIL_CHROME_PROFILE: undefined,
    AGIL_CHROME_USER_DATA_DIR: chromeUserDataDir,
    AGIL_CHROME_PROCESS_DISCOVERY: "0",
    AGIL_TEMP_CHROME_STORAGE_FALLBACK: "0",
    BUN_EXECUTABLE_PATH: process.execPath,
    CHROME_USER_DATA_DIR: chromeUserDataDir,
    COSTAMAR_CHROME_USER_DATA_DIR: chromeUserDataDir,
    FLY_DESK_SEARCH_WORKER_PROCESSES: "1",
    LOCALAPPDATA: tempRoot,
  };
}

function buildAgilRequest(): SearchRequest {
  return {
    providerId: "agil-local",
    tripType: "round-trip",
    searchMode: "exact",
    legs: [
      {
        origin: "LIM",
        destination: "MAD",
        departureDate: "2026-05-28",
        returnDate: "2026-06-04",
      },
    ],
    passengers: {
      adults: 1,
      children: 0,
      infants: 0,
    },
    cabin: "ECONOMY",
    filters: {},
    coverageMode: "core",
    redirectMode: "best-effort",
    currencyCode: "USD",
    locale: "es-PE",
    market: "PE",
  };
}

async function withTemporaryEnv<T>(
  values: Partial<Record<typeof ENV_KEYS[number], string | undefined>>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<typeof ENV_KEYS[number], string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("search workers resolve Bun instead of inheriting a Node executable", () => {
  const userProfile = "C:\\Users\\agent";
  const expectedBunPath = join(userProfile, ".bun", "bin", "bun.exe");

  const resolved = resolveSearchWorkerBunExecutableForTests({
    env: {
      USERPROFILE: userProfile,
    },
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    platform: "win32",
    exists: (path) => path === expectedBunPath,
  });

  assert.equal(resolved, expectedBunPath);
});

test("spawn-per-search workers surface provider errors after starting under Bun", async () => {
  const { tempRoot, chromeUserDataDir } = createEmptyChromeProfile("flydesk-empty-agil-profile-");

  try {
    await withTemporaryEnv({
      ...emptyProfileEnv(chromeUserDataDir, tempRoot),
      FLY_DESK_SEARCH_WORKER_POOL: "0",
    }, async () => {
      /* Another test file may have left the default pool running in this
         process; the assertion below is about this path, not about them. */
      stopSearchWorkerPool();
      await assert.rejects(
        () => runProviderSearchInWorker({
          kind: "exact",
          providerId: "agil-local",
          request: buildAgilRequest(),
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Unable to extract Agil session from Chrome profiles/);
          assert.doesNotMatch(error.message, /exports is not defined|dist[\\/]search-worker\.js|Node\.js/);
          return true;
        },
      );

      /* With the pool off nothing is kept around between searches. */
      assert.equal(searchWorkerPoolPidForTests("agil-local"), undefined);
    });
  } finally {
    removeTempRoot(tempRoot);
  }
});

test("pooled workers survive a failed search and serve the next one from the same process", async () => {
  const { tempRoot, chromeUserDataDir } = createEmptyChromeProfile("flydesk-pooled-agil-profile-");

  try {
    await withTemporaryEnv({
      ...emptyProfileEnv(chromeUserDataDir, tempRoot),
      FLY_DESK_SEARCH_WORKER_POOL: undefined,
    }, async () => {
      try {
        const runOnce = () => assert.rejects(
          () => runProviderSearchInWorker({
            kind: "exact",
            providerId: "agil-local",
            request: buildAgilRequest(),
          }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /Unable to extract Agil session from Chrome profiles/);
            return true;
          },
        );

        await runOnce();
        const firstPid = searchWorkerPoolPidForTests("agil-local");
        assert.ok(typeof firstPid === "number" && firstPid > 0);

        await runOnce();
        assert.equal(searchWorkerPoolPidForTests("agil-local"), firstPid);
      } finally {
        stopSearchWorkerPool();
      }
    });
  } finally {
    removeTempRoot(tempRoot);
  }
});

test("a prewarm message is answered by the pooled worker", async () => {
  const { tempRoot, chromeUserDataDir } = createEmptyChromeProfile("flydesk-prewarm-agil-profile-");

  try {
    await withTemporaryEnv({
      ...emptyProfileEnv(chromeUserDataDir, tempRoot),
      FLY_DESK_SEARCH_WORKER_POOL: undefined,
    }, async () => {
      try {
        await assert.rejects(
          () => prewarmProviderInWorker("agil-local"),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /Unable to extract Agil session from Chrome profiles/);
            return true;
          },
        );
      } finally {
        stopSearchWorkerPool();
      }
    });
  } finally {
    removeTempRoot(tempRoot);
  }
});
