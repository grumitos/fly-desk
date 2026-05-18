import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchRequest } from "../src/core/types";
import {
  resolveSearchWorkerCommandForTests,
  resolveSearchWorkerBunExecutableForTests,
  runProviderSearchInWorker,
} from "../src/search-worker-client";

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
  "FLY_DESK_SEARCH_WORKER_PROCESSES",
  "FLY_DESK_EXECUTABLE_PATH",
  "FLY_DESK_RELEASE_DIR",
  "LOCALAPPDATA",
] as const;

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

test("search workers use the packaged executable in release mode", () => {
  const releaseDir = "C:\\fly-desk\\app\\releases\\0.3.0";
  const executablePath = join(releaseDir, "bin", "fly-desk.exe");

  const command = resolveSearchWorkerCommandForTests({
    env: {
      FLY_DESK_RELEASE_DIR: releaseDir,
      FLY_DESK_EXECUTABLE_PATH: executablePath,
    },
    cwd: "C:\\fly-desk",
    exists: (path) => path === executablePath,
  });

  assert.deepEqual(command, {
    command: executablePath,
    args: ["--fly-desk-worker"],
  });
});

test("provider search workers surface provider errors after starting under Bun", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-empty-agil-profile-"));
  const chromeUserDataDir = join(tempRoot, "Google", "Chrome", "User Data");
  mkdirSync(join(chromeUserDataDir, "Default"), { recursive: true });

  try {
    await withTemporaryEnv({
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
    }, async () => {
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
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
