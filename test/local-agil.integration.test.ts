import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGIL_CONCURRENCY,
  buildLocalAgilSearchRedirectUrl,
  computeAgilTotalAmountForTests,
  createLocalAgilMatrixDraft,
  extractAgilChromeDebugPortsFromCommandLinesForTests,
  extractAgilChromeUserDataDirsFromCommandLinesForTests,
  extractAgilBrowserStorageSnapshotForTests,
  cleanupTemporaryAgilChromeProfileForTests,
  isAgilRawChromeStorageFileScanEnabledForTests,
  isAgilTemporaryChromeStorageFallbackEnabledForTests,
  mapAgilGeoTreeLocation,
  parseAgilApimSubscriptionKeyFromFrontendBundle,
  prepareTemporaryAgilChromeProfileForTests,
  parseAgilRefreshTokenPayload,
  parseAgilSessionData,
  prewarmLocalAgilSession,
  readAgilChromeProfileCandidatesForTests,
  readAgilStorageSnapshotFromPage,
  resetAgilSessionCacheForTests,
  resolveLocalAgilExactProgressive,
  resolveLocalAgilMatrixProgressive,
  resolveAgilBrowserEndpoint,
  resolveAgilChromeDevToolsBrowserWsEndpointForTests,
  sameAgilSessionIdentity,
  resetAgilApimSubscriptionKeyCacheForTests,
  resetAgilInflightLimiterForTests,
  readAgilInflightLimiterStateForTests,
  setAgilSessionForTests,
  searchLocalAgilExact,
  shouldReuseAgilSession,
  suggestLocalAgilLocations,
  throwAgilHttpResponseError,
  extractAgilUsdToPenRate,
} from "../src/local-agil";
import type { SearchRequest } from "../src/core/types";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("Agil autocomplete maps only explicit city and airport suggestion types", () => {
  const city = mapAgilGeoTreeLocation({
    aerocodiata: "rio",
    city: "Río de Janeiro",
    country: "Brasil",
    country_id: "BR",
    search_type: "city",
  });
  const unknown = mapAgilGeoTreeLocation({
    aerocodiata: "lim",
    city: "Lima",
    country: "Perú",
    country_id: "PE",
    search_type: "ALL_AIRPORTS",
  });

  assert.equal(city?.type, "CITY");
  assert.equal(city?.searchType, "city");
  assert.equal(unknown?.type, undefined);
  assert.equal(unknown?.searchType, "ALL_AIRPORTS");
});

test("Agil transport errors never expose fetch diagnostics", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.AGIL_APIM_SUBSCRIPTION_KEY;
  process.env.AGIL_APIM_SUBSCRIPTION_KEY = "test-subscription-key";
  resetAgilApimSubscriptionKeyCacheForTests();
  global.fetch = (async () => {
    throw new Error("request failed with token=secret-fixture at https://provider.invalid/private");
  }) as typeof fetch;

  try {
    await assert.rejects(
      suggestLocalAgilLocations("LIM"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /failed before receiving a response/);
        assert.doesNotMatch(error.message, /secret-fixture|provider\.invalid|token=/);
        return true;
      },
    );
  } finally {
    global.fetch = previousFetch;
    resetAgilApimSubscriptionKeyCacheForTests();
    restoreEnv("AGIL_APIM_SUBSCRIPTION_KEY", previousKey);
  }
});

test("Agil HTTP failures discard provider bodies and status text", async () => {
  const response = new Response(
    "token=short-secret https://provider.invalid/private internal trace",
    {
      status: 503,
      statusText: "trace-secret",
    },
  );

  await assert.rejects(
    throwAgilHttpResponseError(response, "Agil GDS 2"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Agil GDS 2 failed with HTTP 503.");
      assert.doesNotMatch(error.message, /short-secret|provider\.invalid|trace-secret/);
      return true;
    },
  );
  assert.equal(response.bodyUsed, true);
});

test("reads Agil session storage after DOM content is ready without waiting for network idle", async () => {
  const calls: Array<{ kind: string; args: unknown[] }> = [];
  const page = {
    async goto(url: string, options: Record<string, unknown>) {
      calls.push({ kind: "goto", args: [url, options] });
    },
    async waitForFunction(fn: unknown, options: Record<string, unknown>) {
      calls.push({ kind: "waitForFunction", args: [fn, options] });
    },
    async evaluate() {
      calls.push({ kind: "evaluate", args: [] });
      return {
        tokenSearchFlight: "",
        userData: "user",
        ip: "ip",
      };
    },
  };

  const snapshot = await readAgilStorageSnapshotFromPage(page as never);

  assert.deepEqual(snapshot, {
    tokenSearchFlight: "",
    userData: "user",
    ip: "ip",
  });

  assert.deepEqual(calls[0], {
    kind: "goto",
    args: [
      "https://www.agilsmart.com/home-user",
      {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      },
    ],
  });
  assert.equal(calls[1]?.kind, "waitForFunction");
  assert.equal(calls[2]?.kind, "evaluate");
});

test("can derive a refreshable Agil session without tokenSearchFlight", () => {
  const userPayload = Buffer.from(JSON.stringify({
    Usuario: {
      CodigoUsuario: 1234,
    },
    Cliente: {
      Vendedor: {
        CodigoVendedor: "ABCD",
      },
    },
  })).toString("base64");
  const ipPayload = Buffer.from("1.2.3.4").toString("base64");

  const session = parseAgilSessionData({
    tokenSearchFlight: "",
    userData: userPayload,
    ip: ipPayload,
  });

  assert.equal(session.token, "");
  assert.equal(session.expiresAtMs, 0);
  assert.equal(session.userCode, 1234);
  assert.equal(session.internalCode, "ABCD");
  assert.equal(session.ip, "1.2.3.4");
  assert.equal(typeof session.capturedAtMs, "number");
});

test("Agil session cache forces a browser revalidation after a short interval", () => {
  const now = 1_710_000_000_000;

  assert.equal(shouldReuseAgilSession({
    expiresAtMs: now + (10 * 60 * 1000),
    capturedAtMs: now - 30_000,
  }, now), true);

  assert.equal(shouldReuseAgilSession({
    expiresAtMs: now + (10 * 60 * 1000),
    capturedAtMs: now - 120_000,
  }, now), false);
});

test("Agil session identity changes when the browser switches account or seller", () => {
  assert.equal(sameAgilSessionIdentity({
    userCode: 1234,
    internalCode: "ABCD",
    ip: "1.2.3.4",
  }, {
    userCode: 1234,
    internalCode: "ABCD",
    ip: "1.2.3.4",
  }), true);

  assert.equal(sameAgilSessionIdentity({
    userCode: 1234,
    internalCode: "ABCD",
    ip: "1.2.3.4",
  }, {
    userCode: 5678,
    internalCode: "WXYZ",
    ip: "1.2.3.4",
  }), false);
});

test("Agil provider prewarm forces a token refresh even when the cached session is fresh", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-agil-prewarm-refresh-"));
  const profileName = "Profile 40";
  const storageDir = join(tempRoot, profileName, "Local Storage", "leveldb");
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(
    join(tempRoot, "Local State"),
    JSON.stringify({
      profile: {
        last_used: profileName,
        last_active_profiles: [profileName],
        info_cache: {
          [profileName]: {},
        },
      },
    }),
    "utf8",
  );

  const userPayload = Buffer.from(JSON.stringify({
    Usuario: {
      CodigoUsuario: 1234,
    },
    Cliente: {
      Vendedor: {
        CodigoVendedor: "ABCD",
      },
    },
  })).toString("base64");
  const ipPayload = Buffer.from("1.2.3.4").toString("base64");
  writeFileSync(
    join(storageDir, "000001.log"),
    `https://www.agilsmart.com/home-user\0tokenTravelC stale-token user_data ${userPayload} ip ${ipPayload}`,
    "utf8",
  );

  const previousFetch = global.fetch;
  const previousKey = process.env.AGIL_APIM_SUBSCRIPTION_KEY;
  const previousUserDataDir = process.env.AGIL_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.AGIL_CHROME_PROFILE;
  const previousBrowserUrl = process.env.AGIL_BROWSER_URL;
  const previousBrowserWsEndpoint = process.env.AGIL_BROWSER_WS_ENDPOINT;
  const previousProcessDiscovery = process.env.AGIL_CHROME_PROCESS_DISCOVERY;
  const previousScanAllProfiles = process.env.AGIL_SCAN_ALL_CHROME_PROFILES;
  const previousRawFileScan = process.env.AGIL_RAW_CHROME_STORAGE_FILE_SCAN;
  const previousTempFallback = process.env.AGIL_TEMP_CHROME_STORAGE_FALLBACK;
  const previousChromeUserDataDir = process.env.CHROME_USER_DATA_DIR;
  const previousCostamarChromeUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const refreshedTokenPayload = Buffer.from(JSON.stringify({ exp: 1893459600 })).toString("base64url");
  const refreshedToken = `header.${refreshedTokenPayload}.signature`;
  let refreshCalls = 0;

  resetAgilSessionCacheForTests();
  resetAgilApimSubscriptionKeyCacheForTests();
  setAgilSessionForTests({
    token: "cached-token",
    expiresAtMs: Date.now() + 60 * 60 * 1000,
    userCode: 1234,
    internalCode: "ABCD",
    ip: "1.2.3.4",
    capturedAtMs: Date.now(),
  });
  process.env.AGIL_APIM_SUBSCRIPTION_KEY = "test-subscription-key";
  process.env.AGIL_CHROME_USER_DATA_DIR = tempRoot;
  process.env.AGIL_CHROME_PROFILE = profileName;
  process.env.AGIL_CHROME_PROCESS_DISCOVERY = "0";
  process.env.AGIL_SCAN_ALL_CHROME_PROFILES = "0";
  process.env.AGIL_RAW_CHROME_STORAGE_FILE_SCAN = "1";
  process.env.AGIL_TEMP_CHROME_STORAGE_FALLBACK = "0";
  process.env.LOCALAPPDATA = join(tempRoot, "isolated-localappdata");
  delete process.env.AGIL_BROWSER_URL;
  delete process.env.AGIL_BROWSER_WS_ENDPOINT;
  delete process.env.CHROME_USER_DATA_DIR;
  delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;

  global.fetch = (async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    assert.equal(url, "https://motorvuelos.expertiatravel.com/auth/api/auth/token");
    assert.equal(headers.get("Ocp-Apim-Subscription-Key"), "test-subscription-key");
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      caller?: { fromIP?: string };
      userCode?: number;
      internalCode?: string;
    };
    assert.equal(body.caller?.fromIP, "1.2.3.4");
    assert.equal(body.userCode, 1234);
    assert.equal(body.internalCode, "ABCD");
    refreshCalls += 1;
    return new Response(JSON.stringify({ token: refreshedToken }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await prewarmLocalAgilSession();

    assert.equal(refreshCalls, 1);
  } finally {
    global.fetch = previousFetch;
    resetAgilSessionCacheForTests();
    resetAgilApimSubscriptionKeyCacheForTests();
    restoreEnv("AGIL_APIM_SUBSCRIPTION_KEY", previousKey);
    restoreEnv("AGIL_CHROME_USER_DATA_DIR", previousUserDataDir);
    restoreEnv("AGIL_CHROME_PROFILE", previousProfile);
    restoreEnv("AGIL_BROWSER_URL", previousBrowserUrl);
    restoreEnv("AGIL_BROWSER_WS_ENDPOINT", previousBrowserWsEndpoint);
    restoreEnv("AGIL_CHROME_PROCESS_DISCOVERY", previousProcessDiscovery);
    restoreEnv("AGIL_SCAN_ALL_CHROME_PROFILES", previousScanAllProfiles);
    restoreEnv("AGIL_RAW_CHROME_STORAGE_FILE_SCAN", previousRawFileScan);
    restoreEnv("AGIL_TEMP_CHROME_STORAGE_FALLBACK", previousTempFallback);
    restoreEnv("CHROME_USER_DATA_DIR", previousChromeUserDataDir);
    restoreEnv("COSTAMAR_CHROME_USER_DATA_DIR", previousCostamarChromeUserDataDir);
    restoreEnv("LOCALAPPDATA", previousLocalAppData);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Agil profile discovery tries the configured Chrome profile before automatic profiles", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-agil-profiles-"));
  mkdirSync(join(tempRoot, "Profile 10"), { recursive: true });
  mkdirSync(join(tempRoot, "Profile 40"), { recursive: true });
  writeFileSync(
    join(tempRoot, "Local State"),
    JSON.stringify({
      profile: {
        last_used: "Profile 10",
        last_active_profiles: ["Profile 10"],
        info_cache: {
          "Profile 10": {},
          "Profile 40": {},
        },
      },
    }),
    "utf8",
  );

  const previousUserDataDir = process.env.AGIL_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.AGIL_CHROME_PROFILE;
  process.env.AGIL_CHROME_USER_DATA_DIR = tempRoot;
  process.env.AGIL_CHROME_PROFILE = "Profile 40";

  try {
    assert.deepEqual(readAgilChromeProfileCandidatesForTests().slice(0, 2), [
      "Profile 40",
      "Profile 10",
    ]);
  } finally {
    if (previousUserDataDir === undefined) {
      delete process.env.AGIL_CHROME_USER_DATA_DIR;
    } else {
      process.env.AGIL_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.AGIL_CHROME_PROFILE;
    } else {
      process.env.AGIL_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Agil user data discovery reads active Chrome process profile roots", () => {
  assert.deepEqual(extractAgilChromeUserDataDirsFromCommandLinesForTests([
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir=D:\\ChromeRuns\\live-profile --new-window about:blank',
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="D:\\Chrome Runs\\profile with spaces" --profile-directory=Default',
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer --lang=es-419',
  ]), [
    "D:\\ChromeRuns\\live-profile",
    "D:\\Chrome Runs\\profile with spaces",
  ]);
});

test("Agil DevTools discovery reads active Chrome remote debugging ports", () => {
  assert.deepEqual(extractAgilChromeDebugPortsFromCommandLinesForTests([
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir=D:\\ChromeRuns\\live-profile',
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer --remote-debugging-port=9222 --user-data-dir=D:\\ChromeRuns\\live-profile',
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=not-a-port --user-data-dir=D:\\ChromeRuns\\bad',
  ]), [9222]);
});

test("Agil can resolve an active Chrome DevTools browser endpoint from a user data dir", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-agil-devtools-"));
  writeFileSync(join(tempRoot, "DevToolsActivePort"), "9222\n/devtools/browser/session-id\n", "utf8");

  try {
    assert.equal(
      resolveAgilChromeDevToolsBrowserWsEndpointForTests(tempRoot),
      "ws://127.0.0.1:9222/devtools/browser/session-id",
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Agil temporary Chrome storage fallback is opt-in", () => {
  const previous = process.env.AGIL_TEMP_CHROME_STORAGE_FALLBACK;

  try {
    delete process.env.AGIL_TEMP_CHROME_STORAGE_FALLBACK;
    assert.equal(isAgilTemporaryChromeStorageFallbackEnabledForTests(), false);

    process.env.AGIL_TEMP_CHROME_STORAGE_FALLBACK = "1";
    assert.equal(isAgilTemporaryChromeStorageFallbackEnabledForTests(), true);

    process.env.AGIL_TEMP_CHROME_STORAGE_FALLBACK = "0";
    assert.equal(isAgilTemporaryChromeStorageFallbackEnabledForTests(), false);
  } finally {
    if (previous === undefined) {
      delete process.env.AGIL_TEMP_CHROME_STORAGE_FALLBACK;
    } else {
      process.env.AGIL_TEMP_CHROME_STORAGE_FALLBACK = previous;
    }
  }
});

test("Agil raw Chrome storage file scanning is opt-in", () => {
  const previous = process.env.AGIL_RAW_CHROME_STORAGE_FILE_SCAN;

  try {
    delete process.env.AGIL_RAW_CHROME_STORAGE_FILE_SCAN;
    assert.equal(isAgilRawChromeStorageFileScanEnabledForTests(), false);

    process.env.AGIL_RAW_CHROME_STORAGE_FILE_SCAN = "1";
    assert.equal(isAgilRawChromeStorageFileScanEnabledForTests(), true);

    process.env.AGIL_RAW_CHROME_STORAGE_FILE_SCAN = "0";
    assert.equal(isAgilRawChromeStorageFileScanEnabledForTests(), false);
  } finally {
    if (previous === undefined) {
      delete process.env.AGIL_RAW_CHROME_STORAGE_FILE_SCAN;
    } else {
      process.env.AGIL_RAW_CHROME_STORAGE_FILE_SCAN = previous;
    }
  }
});

test("Agil temporary Chrome profile staging is private and copies only minimal storage", async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "flydesk-agil-source-profile-"));
  const profileName = "Profile 42";
  mkdirSync(join(sourceRoot, profileName, "Local Storage", "leveldb"), { recursive: true });
  mkdirSync(join(sourceRoot, profileName, "Session Storage"), { recursive: true });
  writeFileSync(join(sourceRoot, "Local State"), "local-state", "utf8");
  writeFileSync(join(sourceRoot, profileName, "Preferences"), "preferences", "utf8");
  writeFileSync(join(sourceRoot, profileName, "Secure Preferences"), "secure-preferences", "utf8");
  writeFileSync(join(sourceRoot, profileName, "Local Storage", "leveldb", "000001.log"), "agil-storage", "utf8");
  writeFileSync(join(sourceRoot, profileName, "Session Storage", "000002.log"), "session-storage", "utf8");

  const tempProfile = prepareTemporaryAgilChromeProfileForTests(sourceRoot, profileName);

  try {
    assert.equal(existsSync(join(tempProfile, "Local State")), true);
    assert.equal(existsSync(join(tempProfile, profileName, "Preferences")), true);
    assert.equal(existsSync(join(tempProfile, profileName, "Local Storage", "leveldb", "000001.log")), true);
    assert.equal(existsSync(join(tempProfile, profileName, "Secure Preferences")), false);
    assert.equal(existsSync(join(tempProfile, profileName, "Session Storage")), false);

    if (process.platform !== "win32") {
      assert.equal(statSync(tempProfile).mode & 0o777, 0o700);
      assert.equal(statSync(join(tempProfile, "Local State")).mode & 0o777, 0o600);
      assert.equal(
        statSync(join(tempProfile, profileName, "Local Storage", "leveldb", "000001.log")).mode & 0o777,
        0o600,
      );
    }
  } finally {
    await cleanupTemporaryAgilChromeProfileForTests(tempProfile);
    rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test("Agil session extraction keeps the configured profile when cross-profile scan is disabled", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-agil-storage-freshness-"));
  const staleProfile = "Profile 40";
  const freshProfile = "Profile 41";

  const writeAgilStorage = (
    profileName: string,
    userCode: number,
    internalCode: string,
    ip: string,
    mtime: Date,
    token = "",
    origin = "https://www.agilsmart.com/home-user",
  ) => {
    const storageDir = join(tempRoot, profileName, "Local Storage", "leveldb");
    mkdirSync(storageDir, { recursive: true });
    const userPayload = Buffer.from(JSON.stringify({
      Usuario: {
        CodigoUsuario: userCode,
      },
      Cliente: {
        Vendedor: {
          CodigoVendedor: internalCode,
        },
      },
    })).toString("base64");
    const ipPayload = Buffer.from(ip).toString("base64");
    const filePath = join(storageDir, "000001.log");
    writeFileSync(filePath, `${origin}\0tokenTravelC ${token} user_data ${userPayload} ip ${ipPayload}`, "utf8");
    utimesSync(filePath, mtime, mtime);
  };

  writeFileSync(
    join(tempRoot, "Local State"),
    JSON.stringify({
      profile: {
        last_used: staleProfile,
        last_active_profiles: [staleProfile, freshProfile],
        info_cache: {
          [staleProfile]: {},
          [freshProfile]: {},
        },
      },
    }),
    "utf8",
  );

  const tokenPayload = Buffer.from(JSON.stringify({ exp: 1893459600 })).toString("base64url");
  const freshToken = `header.${tokenPayload}.signature`;
  writeAgilStorage(staleProfile, 1111, "STALE", "1.1.1.1", new Date("2026-01-01T00:00:00Z"));
  writeAgilStorage(freshProfile, 2222, "FRESH", "2.2.2.2", new Date("2026-02-01T00:00:00Z"), freshToken);

  const previousUserDataDir = process.env.AGIL_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.AGIL_CHROME_PROFILE;
  const previousBrowserUrl = process.env.AGIL_BROWSER_URL;
  const previousBrowserWsEndpoint = process.env.AGIL_BROWSER_WS_ENDPOINT;
  const previousProcessDiscovery = process.env.AGIL_CHROME_PROCESS_DISCOVERY;
  const previousScanAllProfiles = process.env.AGIL_SCAN_ALL_CHROME_PROFILES;
  const previousRawFileScan = process.env.AGIL_RAW_CHROME_STORAGE_FILE_SCAN;
  const previousTempFallback = process.env.AGIL_TEMP_CHROME_STORAGE_FALLBACK;
  const previousChromeUserDataDir = process.env.CHROME_USER_DATA_DIR;
  const previousCostamarChromeUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.AGIL_CHROME_USER_DATA_DIR = tempRoot;
  process.env.AGIL_CHROME_PROFILE = staleProfile;
  process.env.AGIL_CHROME_PROCESS_DISCOVERY = "0";
  process.env.AGIL_SCAN_ALL_CHROME_PROFILES = "0";
  process.env.AGIL_RAW_CHROME_STORAGE_FILE_SCAN = "1";
  process.env.AGIL_TEMP_CHROME_STORAGE_FALLBACK = "0";
  process.env.LOCALAPPDATA = join(tempRoot, "isolated-localappdata");
  delete process.env.AGIL_BROWSER_URL;
  delete process.env.AGIL_BROWSER_WS_ENDPOINT;
  delete process.env.CHROME_USER_DATA_DIR;
  delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;

  try {
    const snapshot = await extractAgilBrowserStorageSnapshotForTests();
    const session = parseAgilSessionData(snapshot);

    assert.equal(session.userCode, 1111);
    assert.equal(session.internalCode, "STALE");
    assert.equal(session.ip, "1.1.1.1");
    assert.equal(session.token, "");
  } finally {
    if (previousUserDataDir === undefined) {
      delete process.env.AGIL_CHROME_USER_DATA_DIR;
    } else {
      process.env.AGIL_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.AGIL_CHROME_PROFILE;
    } else {
      process.env.AGIL_CHROME_PROFILE = previousProfile;
    }

    if (previousBrowserUrl === undefined) {
      delete process.env.AGIL_BROWSER_URL;
    } else {
      process.env.AGIL_BROWSER_URL = previousBrowserUrl;
    }

    if (previousBrowserWsEndpoint === undefined) {
      delete process.env.AGIL_BROWSER_WS_ENDPOINT;
    } else {
      process.env.AGIL_BROWSER_WS_ENDPOINT = previousBrowserWsEndpoint;
    }

    if (previousProcessDiscovery === undefined) {
      delete process.env.AGIL_CHROME_PROCESS_DISCOVERY;
    } else {
      process.env.AGIL_CHROME_PROCESS_DISCOVERY = previousProcessDiscovery;
    }

    if (previousScanAllProfiles === undefined) {
      delete process.env.AGIL_SCAN_ALL_CHROME_PROFILES;
    } else {
      process.env.AGIL_SCAN_ALL_CHROME_PROFILES = previousScanAllProfiles;
    }

    restoreEnv("AGIL_RAW_CHROME_STORAGE_FILE_SCAN", previousRawFileScan);
    restoreEnv("AGIL_TEMP_CHROME_STORAGE_FALLBACK", previousTempFallback);
    restoreEnv("CHROME_USER_DATA_DIR", previousChromeUserDataDir);
    restoreEnv("COSTAMAR_CHROME_USER_DATA_DIR", previousCostamarChromeUserDataDir);
    restoreEnv("LOCALAPPDATA", previousLocalAppData);

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Agil session extraction ignores non-Agil origin storage in the configured profile", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-agil-storage-origin-"));
  const profileName = "Profile 40";
  let fileCounter = 1;

  const writeStorage = (
    origin: string,
    userCode: number,
    internalCode: string,
    ip: string,
    mtime: Date,
    token = "",
  ) => {
    const storageDir = join(tempRoot, profileName, "Local Storage", "leveldb");
    mkdirSync(storageDir, { recursive: true });
    const userPayload = Buffer.from(JSON.stringify({
      Usuario: {
        CodigoUsuario: userCode,
      },
      Cliente: {
        Vendedor: {
          CodigoVendedor: internalCode,
        },
      },
    })).toString("base64");
    const ipPayload = Buffer.from(ip).toString("base64");
    const filePath = join(storageDir, `${String(fileCounter).padStart(6, "0")}.log`);
    fileCounter += 1;
    writeFileSync(filePath, `${origin}\0tokenTravelC ${token} user_data ${userPayload} ip ${ipPayload}`, "utf8");
    utimesSync(filePath, mtime, mtime);
  };

  writeFileSync(
    join(tempRoot, "Local State"),
    JSON.stringify({
      profile: {
        last_used: profileName,
        last_active_profiles: [profileName],
        info_cache: {
          [profileName]: {},
        },
      },
    }),
    "utf8",
  );

  const tokenPayload = Buffer.from(JSON.stringify({ exp: 1893459600 })).toString("base64url");
  const evilToken = `header.${tokenPayload}.signature`;
  writeStorage("https://www.agilsmart.com/home-user", 1111, "AGIL", "1.1.1.1", new Date("2026-01-01T00:00:00Z"));
  writeStorage("https://evil.example/", 9999, "EVIL", "9.9.9.9", new Date("2026-02-01T00:00:00Z"), evilToken);

  const previousUserDataDir = process.env.AGIL_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.AGIL_CHROME_PROFILE;
  const previousBrowserUrl = process.env.AGIL_BROWSER_URL;
  const previousBrowserWsEndpoint = process.env.AGIL_BROWSER_WS_ENDPOINT;
  const previousProcessDiscovery = process.env.AGIL_CHROME_PROCESS_DISCOVERY;
  const previousScanAllProfiles = process.env.AGIL_SCAN_ALL_CHROME_PROFILES;
  const previousRawFileScan = process.env.AGIL_RAW_CHROME_STORAGE_FILE_SCAN;
  const previousTempFallback = process.env.AGIL_TEMP_CHROME_STORAGE_FALLBACK;
  const previousChromeUserDataDir = process.env.CHROME_USER_DATA_DIR;
  const previousCostamarChromeUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.AGIL_CHROME_USER_DATA_DIR = tempRoot;
  process.env.AGIL_CHROME_PROFILE = profileName;
  process.env.AGIL_CHROME_PROCESS_DISCOVERY = "0";
  process.env.AGIL_SCAN_ALL_CHROME_PROFILES = "0";
  process.env.AGIL_RAW_CHROME_STORAGE_FILE_SCAN = "1";
  process.env.AGIL_TEMP_CHROME_STORAGE_FALLBACK = "0";
  process.env.LOCALAPPDATA = join(tempRoot, "isolated-localappdata");
  delete process.env.AGIL_BROWSER_URL;
  delete process.env.AGIL_BROWSER_WS_ENDPOINT;
  delete process.env.CHROME_USER_DATA_DIR;
  delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;

  try {
    const snapshot = await extractAgilBrowserStorageSnapshotForTests();
    const session = parseAgilSessionData(snapshot);

    assert.equal(session.userCode, 1111);
    assert.equal(session.internalCode, "AGIL");
    assert.equal(session.ip, "1.1.1.1");
    assert.equal(session.token, "");
  } finally {
    if (previousUserDataDir === undefined) {
      delete process.env.AGIL_CHROME_USER_DATA_DIR;
    } else {
      process.env.AGIL_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.AGIL_CHROME_PROFILE;
    } else {
      process.env.AGIL_CHROME_PROFILE = previousProfile;
    }

    if (previousBrowserUrl === undefined) {
      delete process.env.AGIL_BROWSER_URL;
    } else {
      process.env.AGIL_BROWSER_URL = previousBrowserUrl;
    }

    if (previousBrowserWsEndpoint === undefined) {
      delete process.env.AGIL_BROWSER_WS_ENDPOINT;
    } else {
      process.env.AGIL_BROWSER_WS_ENDPOINT = previousBrowserWsEndpoint;
    }

    if (previousProcessDiscovery === undefined) {
      delete process.env.AGIL_CHROME_PROCESS_DISCOVERY;
    } else {
      process.env.AGIL_CHROME_PROCESS_DISCOVERY = previousProcessDiscovery;
    }

    if (previousScanAllProfiles === undefined) {
      delete process.env.AGIL_SCAN_ALL_CHROME_PROFILES;
    } else {
      process.env.AGIL_SCAN_ALL_CHROME_PROFILES = previousScanAllProfiles;
    }

    restoreEnv("AGIL_RAW_CHROME_STORAGE_FILE_SCAN", previousRawFileScan);
    restoreEnv("AGIL_TEMP_CHROME_STORAGE_FALLBACK", previousTempFallback);
    restoreEnv("CHROME_USER_DATA_DIR", previousChromeUserDataDir);
    restoreEnv("COSTAMAR_CHROME_USER_DATA_DIR", previousCostamarChromeUserDataDir);
    restoreEnv("LOCALAPPDATA", previousLocalAppData);

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Agil default extraction ignores planted arbitrary-origin raw storage with Agil-looking keys", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-agil-storage-planted-"));
  const profileName = "Profile 40";
  const storageDir = join(tempRoot, profileName, "Local Storage", "leveldb");
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(
    join(tempRoot, "Local State"),
    JSON.stringify({
      profile: {
        last_used: profileName,
        last_active_profiles: [profileName],
        info_cache: {
          [profileName]: {},
        },
      },
    }),
    "utf8",
  );

  const tokenPayload = Buffer.from(JSON.stringify({ exp: 1893459600 })).toString("base64url");
  const plantedToken = `header.${tokenPayload}.signature`;
  const plantedUserData = Buffer.from(JSON.stringify({
    Usuario: {
      CodigoUsuario: 9999,
    },
    Cliente: {
      Vendedor: {
        CodigoVendedor: "EVIL",
      },
    },
  })).toString("base64");
  const plantedIp = Buffer.from("9.9.9.9").toString("base64");
  writeFileSync(
    join(storageDir, "000001.log"),
    [
      "https://attacker.example/app",
      "attacker-controlled-value",
      "https://www.agilsmart.com/home-user",
      `tokenSearchFlight ${plantedToken}`,
      `user_data ${plantedUserData}`,
      `ip ${plantedIp}`,
    ].join("\0"),
    "utf8",
  );

  const previousUserDataDir = process.env.AGIL_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.AGIL_CHROME_PROFILE;
  const previousBrowserUrl = process.env.AGIL_BROWSER_URL;
  const previousBrowserWsEndpoint = process.env.AGIL_BROWSER_WS_ENDPOINT;
  const previousProcessDiscovery = process.env.AGIL_CHROME_PROCESS_DISCOVERY;
  const previousScanAllProfiles = process.env.AGIL_SCAN_ALL_CHROME_PROFILES;
  const previousRawFileScan = process.env.AGIL_RAW_CHROME_STORAGE_FILE_SCAN;
  const previousTempFallback = process.env.AGIL_TEMP_CHROME_STORAGE_FALLBACK;
  const previousChromeUserDataDir = process.env.CHROME_USER_DATA_DIR;
  const previousCostamarChromeUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.AGIL_CHROME_USER_DATA_DIR = tempRoot;
  process.env.AGIL_CHROME_PROFILE = profileName;
  process.env.AGIL_CHROME_PROCESS_DISCOVERY = "0";
  process.env.AGIL_SCAN_ALL_CHROME_PROFILES = "0";
  process.env.AGIL_TEMP_CHROME_STORAGE_FALLBACK = "0";
  process.env.LOCALAPPDATA = join(tempRoot, "isolated-localappdata");
  delete process.env.AGIL_BROWSER_URL;
  delete process.env.AGIL_BROWSER_WS_ENDPOINT;
  delete process.env.AGIL_RAW_CHROME_STORAGE_FILE_SCAN;
  delete process.env.CHROME_USER_DATA_DIR;
  delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;

  try {
    await assert.rejects(
      () => extractAgilBrowserStorageSnapshotForTests(),
      /Unable to extract Agil session from Chrome profiles/,
    );
  } finally {
    restoreEnv("AGIL_CHROME_USER_DATA_DIR", previousUserDataDir);
    restoreEnv("AGIL_CHROME_PROFILE", previousProfile);
    restoreEnv("AGIL_BROWSER_URL", previousBrowserUrl);
    restoreEnv("AGIL_BROWSER_WS_ENDPOINT", previousBrowserWsEndpoint);
    restoreEnv("AGIL_CHROME_PROCESS_DISCOVERY", previousProcessDiscovery);
    restoreEnv("AGIL_SCAN_ALL_CHROME_PROFILES", previousScanAllProfiles);
    restoreEnv("AGIL_RAW_CHROME_STORAGE_FILE_SCAN", previousRawFileScan);
    restoreEnv("AGIL_TEMP_CHROME_STORAGE_FALLBACK", previousTempFallback);
    restoreEnv("CHROME_USER_DATA_DIR", previousChromeUserDataDir);
    restoreEnv("COSTAMAR_CHROME_USER_DATA_DIR", previousCostamarChromeUserDataDir);
    restoreEnv("LOCALAPPDATA", previousLocalAppData);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("falls back to the motorvuelos origin when tokenSearchFlight is missing on agilsmart", async () => {
  const snapshots = [
    {
      tokenSearchFlight: "",
      userData: "user",
      ip: "ip",
    },
    {
      tokenSearchFlight: "token-from-motorvuelos",
      userData: "",
      ip: "",
    },
  ];
  const visitedUrls: string[] = [];
  const page = {
    async goto(url: string) {
      visitedUrls.push(url);
    },
    async waitForFunction() {
      return undefined;
    },
    async evaluate() {
      return snapshots.shift();
    },
  };

  const snapshot = await readAgilStorageSnapshotFromPage(page as never);

  assert.deepEqual(visitedUrls, [
    "https://www.agilsmart.com/home-user",
    "https://motorvuelos.expertiatravel.com/",
  ]);
  assert.equal(snapshot.tokenSearchFlight, "token-from-motorvuelos");
  assert.equal(snapshot.userData, "user");
  assert.equal(snapshot.ip, "ip");
});

test("continues to motorvuelos when agilsmart navigation fails", async () => {
  let evaluations = 0;
  const visitedUrls: string[] = [];
  const page = {
    async goto(url: string) {
      visitedUrls.push(url);
      if (url.includes("agilsmart.com")) {
        throw new Error("DNS failure");
      }
    },
    async waitForFunction() {
      return undefined;
    },
    async evaluate() {
      evaluations += 1;
      return {
        tokenSearchFlight: "token-from-motorvuelos",
        userData: "user",
        ip: "ip",
      };
    },
  };

  const snapshot = await readAgilStorageSnapshotFromPage(page as never);

  assert.deepEqual(visitedUrls, [
    "https://www.agilsmart.com/home-user",
    "https://motorvuelos.expertiatravel.com/",
  ]);
  assert.equal(evaluations, 1);
  assert.equal(snapshot.tokenSearchFlight, "token-from-motorvuelos");
  assert.equal(snapshot.userData, "user");
  assert.equal(snapshot.ip, "ip");
});

test("accepts accessToken from the Agil refresh payload", () => {
  const token = "header.payload.signature";

  assert.equal(
    parseAgilRefreshTokenPayload({
      accessToken: token,
      expiresIn: 86400,
    }),
    token,
  );
});

test("builds Agil redirect URLs with human-readable origin and destination labels when present", () => {
  const url = buildLocalAgilSearchRedirectUrl({
    tripType: "round-trip",
    searchMode: "exact",
    legs: [
      {
        origin: "LIM",
        destination: "MIA",
        originLabel: "LIM - Lima, Peru",
        destinationLabel: "MIA - Miami, Usa",
        departureDate: "2026-04-15",
        returnDate: "2026-04-22",
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
  });

  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("departureLocation"), "LIM Lima, Peru");
  assert.equal(parsed.searchParams.get("arrivalLocation"), "MIA Miami, Usa");
  assert.equal(parsed.searchParams.get("departureDate"), "15/04/2026");
  assert.equal(parsed.searchParams.get("arrivalDate"), "22/04/2026");
});

test("keeps Agil range searches lighter than matrix fan-out by default", () => {
  assert.equal(AGIL_CONCURRENCY.matrixMinimum, 4);
  assert.equal(AGIL_CONCURRENCY.rangeMinimum, 2);
  assert.ok(AGIL_CONCURRENCY.matrixCell >= AGIL_CONCURRENCY.matrixMinimum);
  assert.ok(AGIL_CONCURRENCY.rangeSearch >= AGIL_CONCURRENCY.rangeMinimum);
  assert.ok(AGIL_CONCURRENCY.rangeSearch < AGIL_CONCURRENCY.matrixCell);
  assert.ok(AGIL_CONCURRENCY.gdsSearch >= 1);
});

test("extracts the Agil subscription key from the public frontend bundle", () => {
  const key = parseAgilApimSubscriptionKeyFromFrontendBundle(
    'const env={urlHeaderMotor:"e9c66b5e1b4348ae9de63ff98d66cbbe"};',
  );

  assert.equal(key, "e9c66b5e1b4348ae9de63ff98d66cbbe");
});

test("Agil pricing prefers the provider total when fare breakdowns disagree", () => {
  const amount = computeAgilTotalAmountForTests({
    totalFare: "521.22",
    itinTotalFare: {
      fareBreakDowns: [
        {
          passengerType: { quantity: 1 },
          passengerFare: {
            totalFare: "510.22",
            feeNMV: "0",
            feePTA: "0",
            dsctoTaxes: "0",
          },
        },
      ],
    },
  });

  assert.equal(amount, 521.22);
});

test("Agil pricing does not add provider fee fields on top of fare breakdown totals", () => {
  const amount = computeAgilTotalAmountForTests({
    itinTotalFare: {
      fareBreakDowns: [
        {
          passengerType: { quantity: 2 },
          passengerFare: {
            totalFare: "USD 1,001.16",
            feeNMV: "11.80",
            feePTA: "0",
            dsctoTaxes: "0",
          },
        },
      ],
    },
  });

  assert.equal(amount, 2002.32);
});

test("Agil exchange rate parsing preserves four decimal rates", () => {
  const rate = extractAgilUsdToPenRate({
    tipoCambio: {
      code: "USD",
      rate: "3.7531",
    },
  } as never);

  assert.equal(rate, 3.7531);
});

function buildAgilExactRequest(tripType: "one-way" | "round-trip"): SearchRequest {
  return {
    tripType,
    searchMode: "exact",
    legs: [
      {
        origin: "LIM",
        destination: "MAD",
        departureDate: "2026-05-21",
        ...(tripType === "round-trip" ? { returnDate: "2026-05-28" } : {}),
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

function buildAgilCandidate(
  segmentId: number,
  origin: string,
  destination: string,
  departureDateTime: string,
  arrivalDateTime: string,
  flightNumber: number,
  options: {
    seatsRemaining?: number;
    operatingCarrier?: { code: string; name: string };
  } = {},
) {
  return {
    segmentId,
    startDateTime: departureDateTime,
    endDateTime: arrivalDateTime,
    stops: 0,
    flightDuration: "0200",
    flightSegments: [
      {
        flightNumber,
        departureDateTime,
        arrivalDateTime,
        elapsedTime: "0200",
        seatsRemaining: options.seatsRemaining ?? 4,
        departureAirport: { code: origin, name: origin },
        arrivalAirport: { code: destination, name: destination },
        marketingAirline: { code: "UX", name: "Air Europa" },
        operatingAirline: options.operatingCarrier ?? { code: "UX", name: "Air Europa" },
      },
    ],
  };
}

function buildAgilOptionsGroup(returnSegments = true) {
  return {
    id: returnSegments ? "agil-options" : "agil-one-way-options",
    display: true,
    airline: { code: "UX", name: "Air Europa" },
    departure: [
      {
        segments: [
          buildAgilCandidate(10, "LIM", "MAD", "2026-05-21T08:00:00", "2026-05-21T16:00:00", 100, {
            operatingCarrier: { code: " la ", name: "LATAM Airlines" },
          }),
          buildAgilCandidate(12, "LIM", "MAD", "2026-05-21T10:00:00", "2026-05-21T18:00:00", 102),
        ],
      },
    ],
    ...(returnSegments
      ? {
        returns: [
          {
            segments: [
              buildAgilCandidate(11, "MAD", "LIM", "2026-05-28T09:00:00", "2026-05-28T15:00:00", 101, { seatsRemaining: 3 }),
              buildAgilCandidate(13, "MAD", "LIM", "2026-05-28T11:00:00", "2026-05-28T17:00:00", 103, { seatsRemaining: 3 }),
            ],
          },
        ],
      }
      : {}),
    pricingInfo: {
      totalFare: 950,
      itinTotalFare: {
        validatingCarrier: "UX",
        fareBreakDowns: [
          {
            passengerType: { quantity: 1 },
            passengerFare: {
              baseFare: 700,
              taxes: 250,
              totalFare: 950,
              feeNMV: 0,
              feePTA: 0,
              dsctoTaxes: 0,
            },
          },
        ],
      },
      tipoCambio: {
        code: "USD",
        rate: 3.7531,
      },
    },
  };
}

function applyAgilBaggageToGroup(group: unknown, equipaje: Record<string, unknown>): void {
  const record = group as Record<string, unknown>;
  const journeyGroups = [record.departure, record.returns];

  journeyGroups.forEach((journeyGroup) => {
    const slices = Array.isArray(journeyGroup) ? journeyGroup : journeyGroup ? [journeyGroup] : [];
    slices.forEach((slice) => {
      const segments = Array.isArray((slice as { segments?: unknown }).segments)
        ? (slice as { segments: Array<Record<string, unknown>> }).segments
        : [];
      segments.forEach((segment) => {
        segment.equipaje = equipaje;
      });
    });
  });
}

async function withMockedAgilExactSearch<T>(group: unknown, run: () => Promise<T>): Promise<T> {
  const previousFetch = global.fetch;
  const previousKey = process.env.AGIL_APIM_SUBSCRIPTION_KEY;

  resetAgilSessionCacheForTests();
  resetAgilApimSubscriptionKeyCacheForTests();
  process.env.AGIL_APIM_SUBSCRIPTION_KEY = "test-subscription-key";
  setAgilSessionForTests();
  global.fetch = (async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Ocp-Apim-Subscription-Key"), "test-subscription-key");

    if (url === "https://motorvuelos.expertiatravel.com/mv/start-search") {
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "https://motorvuelos.expertiatravel.com/mv/search") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { gds?: number };
      return new Response(JSON.stringify({
        groups: body.gds === 0 ? [group] : [],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    return await run();
  } finally {
    global.fetch = previousFetch;
    resetAgilSessionCacheForTests();
    resetAgilApimSubscriptionKeyCacheForTests();
    if (previousKey === undefined) {
      delete process.env.AGIL_APIM_SUBSCRIPTION_KEY;
    } else {
      process.env.AGIL_APIM_SUBSCRIPTION_KEY = previousKey;
    }
  }
}

test("Agil exact search expands candidate combinations inside a group", async () => {
  const scenarios = [
    {
      name: "round-trip",
      request: buildAgilExactRequest("round-trip"),
      group: buildAgilOptionsGroup(true),
      expected: [
        ["100", "101"],
        ["100", "103"],
        ["102", "101"],
        ["102", "103"],
      ],
    },
    {
      name: "one-way",
      request: buildAgilExactRequest("one-way"),
      group: buildAgilOptionsGroup(false),
      expected: [
        ["100"],
        ["102"],
      ],
    },
  ];

  for (const scenario of scenarios) {
    await withMockedAgilExactSearch(scenario.group, async () => {
      const result = await searchLocalAgilExact(scenario.request);
      const flightNumbers = result.offers
        .map((offer) => offer.itineraries.map((itinerary) => itinerary.segments[0]?.flightNumber))
        .sort();

      assert.equal(result.offers.length, scenario.expected.length, scenario.name);
      assert.deepEqual(flightNumbers, scenario.expected, scenario.name);
      const expectedScope = JSON.stringify([
        "agil-local",
        0,
        scenario.request.tripType,
        "LIM",
        "MAD",
        "2026-05-21",
        scenario.request.tripType === "round-trip" ? "2026-05-28" : null,
      ]);
      assert.ok(result.offers.every((offer) => offer.rawRefs?.scheduleGroupScope === expectedScope));
      assert.ok(result.offers.every((offer) => offer.rawRefs?.scheduleVariantsTruncated === false));
      if (scenario.name === "round-trip") {
        assert.ok(result.offers.every((offer) => offer.fareMeta?.seatsRemaining === 3));
        const codeshare = result.offers.find((offer) => offer.itineraries[0]?.segments[0]?.flightNumber === "100");
        assert.equal(codeshare?.itineraries[0]?.segments[0]?.marketingCarrier, "UX");
        assert.equal(codeshare?.itineraries[0]?.segments[0]?.operatingCarrier, "LA");
        assert.equal(codeshare?.itineraries[0]?.segments[0]?.operatingCarrierName, "LATAM");
      }
    });
  }
});

test("Agil does not invent carrier or flight number when the provider omits them", async () => {
  const group = buildAgilOptionsGroup(false);
  const groupRecord = group as unknown as {
    airline?: { code?: string; name?: string };
    pricingInfo?: { itinTotalFare?: { validatingCarrier?: string } };
    departure?: Array<{ segments?: Array<{ flightSegments?: Array<{
      flightNumber?: number;
      marketingAirline?: { code?: string; name?: string };
      operatingAirline?: { code?: string; name?: string };
    }> }> }>;
  };
  delete groupRecord.airline;
  if (groupRecord.pricingInfo?.itinTotalFare) {
    delete groupRecord.pricingInfo.itinTotalFare.validatingCarrier;
  }
  const providerSegment = groupRecord.departure?.[0]?.segments?.[0]?.flightSegments?.[0];
  assert.ok(providerSegment);
  delete providerSegment.flightNumber;
  delete providerSegment.marketingAirline;
  delete providerSegment.operatingAirline;

  await withMockedAgilExactSearch(group, async () => {
    const result = await searchLocalAgilExact(buildAgilExactRequest("one-way"));
    const segment = result.offers
      .flatMap((offer) => offer.itineraries.flatMap((itinerary) => itinerary.segments))
      .find((candidate) => candidate.departureAt === "2026-05-21T08:00:00");

    assert.ok(segment);
    assert.equal(segment.marketingCarrier, "");
    assert.equal(segment.operatingCarrier, "");
    assert.equal(segment.flightNumber, "");
  });
});

test("Agil uses the VPS Chrome loopback endpoint by default only on Linux", () => {
  assert.equal(resolveAgilBrowserEndpoint({}, "linux"), "http://127.0.0.1:9222");
  assert.equal(resolveAgilBrowserEndpoint({}, "win32"), undefined);
  assert.equal(
    resolveAgilBrowserEndpoint({ AGIL_BROWSER_URL: "http://127.0.0.1:9333" }, "linux"),
    "http://127.0.0.1:9333",
  );
  assert.equal(
    resolveAgilBrowserEndpoint({ AGIL_BROWSER_WS_ENDPOINT: "ws://127.0.0.1:9444/devtools/browser/test" }, "linux"),
    "ws://127.0.0.1:9444/devtools/browser/test",
  );
});

test("Agil exact search marks schedule variants truncated only when the native product exceeds 50", async () => {
  const group = buildAgilOptionsGroup(true);
  const departureSlice = group.departure[0];
  const returnSlice = group.returns?.[0];
  assert.ok(departureSlice);
  assert.ok(returnSlice);

  departureSlice.segments = Array.from({ length: 6 }, (_, index) => {
    const hour = String(6 + index).padStart(2, "0");
    const arrivalHour = String(7 + index).padStart(2, "0");
    return buildAgilCandidate(
      100 + index,
      "LIM",
      "MAD",
      `2026-05-21T${hour}:00:00`,
      `2026-05-21T${arrivalHour}:00:00`,
      200 + index,
    );
  });
  returnSlice.segments = Array.from({ length: 10 }, (_, index) => {
    const hour = String(6 + index).padStart(2, "0");
    const arrivalHour = String(7 + index).padStart(2, "0");
    return buildAgilCandidate(
      200 + index,
      "MAD",
      "LIM",
      `2026-05-28T${hour}:00:00`,
      `2026-05-28T${arrivalHour}:00:00`,
      300 + index,
    );
  });

  await withMockedAgilExactSearch(group, async () => {
    const result = await searchLocalAgilExact(buildAgilExactRequest("round-trip"));

    assert.equal(result.offers.length, 50);
    assert.ok(result.offers.every((offer) => offer.rawRefs?.scheduleVariantsTruncated === true));
    assert.ok(result.offers.every((offer) => offer.rawRefs?.scheduleGroupScope === JSON.stringify([
      "agil-local",
      0,
      "round-trip",
      "LIM",
      "MAD",
      "2026-05-21",
      "2026-05-28",
    ])));
  });
});

test("Agil exact search treats zero pieces without cabina as no included baggage", async () => {
  const group = buildAgilOptionsGroup(true);
  applyAgilBaggageToGroup(group, { piezas: 0 });

  await withMockedAgilExactSearch(group, async () => {
    const result = await searchLocalAgilExact(buildAgilExactRequest("round-trip"));

    assert.ok(result.offers.length > 0);
    result.offers.forEach((offer) => {
      assert.equal(offer.baggage?.carryOnIncluded, false);
      assert.equal(offer.baggage?.checkedIncluded, false);
      assert.equal(offer.baggage?.description, "Sin equipaje incluido");
    });
  });
});

test("Agil exact search treats positive cabina pieces as carry-on included", async () => {
  const group = buildAgilOptionsGroup(true);
  applyAgilBaggageToGroup(group, {
    piezas: 0,
    cabina: {
      piezas: 1,
      descripcion1: "Equipaje de mano",
    },
  });

  await withMockedAgilExactSearch(group, async () => {
    const result = await searchLocalAgilExact(buildAgilExactRequest("round-trip"));

    assert.ok(result.offers.length > 0);
    result.offers.forEach((offer) => {
      assert.equal(offer.baggage?.carryOnIncluded, true);
      assert.equal(offer.baggage?.checkedIncluded, false);
      assert.equal(offer.baggage?.description, "Equipaje de mano incluido");
    });
  });
});

test("Agil matrix cells include the canonical offer schedules", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.AGIL_APIM_SUBSCRIPTION_KEY;
  const request: SearchRequest = {
    tripType: "round-trip",
    searchMode: "roundtrip-grid",
    flexibleMode: "exact-stay",
    legs: [
      {
        origin: "LIM",
        destination: "CUZ",
        departureStart: "2026-10-16",
        departureEnd: "2026-10-16",
        stayNights: 3,
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
  const agilGroup = {
    id: "agil-lim-cuz-10341",
    display: true,
    airline: {
      code: "JA",
      name: "JetSMART",
    },
    departure: [
      {
        segments: [
          {
            segmentId: 10,
            startDateTime: "2026-10-16T06:15:00",
            endDateTime: "2026-10-16T07:35:00",
            stops: 0,
            flightDuration: "01:20",
            equipaje: {
              piezas: 0,
              cabina: {
                piezas: 1,
                descripcion1: "Equipaje de mano",
              },
            },
            flightSegments: [
              {
                flightNumber: 123,
                departureDateTime: "2026-10-16T06:15:00",
                arrivalDateTime: "2026-10-16T07:35:00",
                elapsedTime: "01:20",
                seatsRemaining: 4,
                departureAirport: {
                  code: "LIM",
                  name: "Lima",
                },
                arrivalAirport: {
                  code: "CUZ",
                  name: "Cusco",
                },
                marketingAirline: {
                  code: "JA",
                  name: "JetSMART",
                },
                operatingAirline: {
                  code: "JA",
                  name: "JetSMART",
                },
              },
            ],
          },
        ],
      },
    ],
    returns: {
      segments: [
        {
          segmentId: 20,
          startDateTime: "2026-10-19T18:10:00",
          endDateTime: "2026-10-19T19:35:00",
          stops: 0,
          flightDuration: "01:25",
          equipaje: {
            piezas: 0,
            cabina: {
              piezas: 1,
              descripcion1: "Equipaje de mano",
            },
          },
          flightSegments: [
            {
              flightNumber: 124,
              departureDateTime: "2026-10-19T18:10:00",
              arrivalDateTime: "2026-10-19T19:35:00",
              elapsedTime: "01:25",
              seatsRemaining: 3,
              departureAirport: {
                code: "CUZ",
                name: "Cusco",
              },
              arrivalAirport: {
                code: "LIM",
                name: "Lima",
              },
              marketingAirline: {
                code: "JA",
                name: "JetSMART",
              },
              operatingAirline: {
                code: "JA",
                name: "JetSMART",
              },
            },
          ],
        },
      ],
    },
    pricingInfo: {
      totalFare: 103.41,
      itinTotalFare: {
        validatingCarrier: "JA",
        fareBreakDowns: [
          {
            passengerType: {
              quantity: 1,
            },
            passengerFare: {
              baseFare: 75,
              taxes: 28.41,
              totalFare: 103.41,
              feeNMV: 0,
              feePTA: 0,
              dsctoTaxes: 0,
            },
          },
        ],
      },
      tipoCambio: {
        code: "USD",
        rate: 3.7531,
      },
    },
  };

  resetAgilSessionCacheForTests();
  resetAgilApimSubscriptionKeyCacheForTests();
  process.env.AGIL_APIM_SUBSCRIPTION_KEY = "test-subscription-key";
  setAgilSessionForTests();
  global.fetch = (async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Ocp-Apim-Subscription-Key"), "test-subscription-key");

    if (url === "https://motorvuelos.expertiatravel.com/mv/start-search") {
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "https://motorvuelos.expertiatravel.com/mv/search") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { gds?: number };
      return new Response(JSON.stringify({
        groups: body.gds === 0 ? [agilGroup] : [],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const draft = createLocalAgilMatrixDraft(request, {
      exactProvider: "agil-local",
      coverageMode: "core",
    });
    const result = await resolveLocalAgilMatrixProgressive(request, draft);
    const cell = result.cells[0];
    const offer = cell?.offer;

    assert.equal(cell?.providerSource, "agil-local");
    assert.equal(cell?.price?.amount, 103.41);
    assert.equal(cell?.price?.currencyCode, "USD");
    assert.equal(offer?.providerSource, "agil-local");
    assert.equal(offer?.price.total.amount, 103.41);
    assert.equal(offer?.itineraries.length, 2);
    assert.equal(offer?.itineraries[0]?.segments[0]?.departureAt, "2026-10-16T06:15:00");
    assert.equal(offer?.itineraries[0]?.segments[0]?.arrivalAt, "2026-10-16T07:35:00");
    assert.equal(offer?.itineraries[1]?.segments[0]?.departureAt, "2026-10-19T18:10:00");
    assert.equal(offer?.itineraries[1]?.segments[0]?.arrivalAt, "2026-10-19T19:35:00");
  } finally {
    global.fetch = previousFetch;
    resetAgilSessionCacheForTests();
    resetAgilApimSubscriptionKeyCacheForTests();
    if (previousKey === undefined) {
      delete process.env.AGIL_APIM_SUBSCRIPTION_KEY;
    } else {
      process.env.AGIL_APIM_SUBSCRIPTION_KEY = previousKey;
    }
  }
});

test("recovers AGIL_APIM_SUBSCRIPTION_KEY from the Agil frontend bundle when env is missing", async () => {
  const previousKey = process.env.AGIL_APIM_SUBSCRIPTION_KEY;
  const previousFetch = global.fetch;
  const calls: string[] = [];

  resetAgilApimSubscriptionKeyCacheForTests();
  delete process.env.AGIL_APIM_SUBSCRIPTION_KEY;
  global.fetch = (async (input, init) => {
    const url = String(input);
    calls.push(url);

    if (url === "https://www.agilsmart.com/home-user") {
      return new Response(
        '<html><head><script src="/runtime.js"></script><script src="/main.js"></script></head></html>',
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    }

    if (url === "https://www.agilsmart.com/main.js") {
      return new Response(
        'const env={urlHeaderMotor:"dynamic-subscription-key-123456"};',
        { status: 200, headers: { "Content-Type": "application/javascript" } },
      );
    }

    if (url === "https://motorvuelos.expertiatravel.com/mv/ubigeo/geotree/Lima") {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Ocp-Apim-Subscription-Key"), "dynamic-subscription-key-123456");
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const suggestions = await suggestLocalAgilLocations("Lima");
    assert.deepEqual(suggestions, []);
    assert.deepEqual(calls, [
      "https://www.agilsmart.com/home-user",
      "https://www.agilsmart.com/main.js",
      "https://motorvuelos.expertiatravel.com/mv/ubigeo/geotree/Lima",
    ]);
  } finally {
    resetAgilApimSubscriptionKeyCacheForTests();
    global.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.AGIL_APIM_SUBSCRIPTION_KEY;
    } else {
      process.env.AGIL_APIM_SUBSCRIPTION_KEY = previousKey;
    }
  }
});

test("fails clearly when neither env nor the Agil frontend expose the subscription key", async () => {
  const previousKey = process.env.AGIL_APIM_SUBSCRIPTION_KEY;
  const previousFetch = global.fetch;
  let apiFetchCalled = false;

  resetAgilApimSubscriptionKeyCacheForTests();
  delete process.env.AGIL_APIM_SUBSCRIPTION_KEY;
  global.fetch = (async (input) => {
    const url = String(input);
    if (url === "https://www.agilsmart.com/home-user") {
      return new Response(
        '<html><head><script src="/main.js"></script></head></html>',
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    }

    if (url === "https://www.agilsmart.com/main.js") {
      return new Response(
        "const env={urlApiMotorVuelos:\"https://motorvuelos.expertiatravel.com\"};",
        { status: 200, headers: { "Content-Type": "application/javascript" } },
      );
    }

    if (url === "https://motorvuelos.expertiatravel.com/mv/ubigeo/geotree/Lima") {
      apiFetchCalled = true;
      throw new Error("API fetch should not run without a subscription key");
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => suggestLocalAgilLocations("Lima"),
      /AGIL_APIM_SUBSCRIPTION_KEY is required for live Agil requests and could not be recovered from the Agil frontend\./,
    );
    assert.equal(apiFetchCalled, false);
  } finally {
    resetAgilApimSubscriptionKeyCacheForTests();
    global.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.AGIL_APIM_SUBSCRIPTION_KEY;
    } else {
      process.env.AGIL_APIM_SUBSCRIPTION_KEY = previousKey;
    }
  }
});

const AGIL_PERSISTED_IDENTITY = {
  userCode: 1234,
  internalCode: "ABCD",
  ip: "1.2.3.4",
};

/* The staged Chrome profile deliberately holds a *different* identity, so a
   browser round-trip cannot happen unnoticed: it would mint for this identity
   and overwrite the identity file with it. */
const AGIL_BROWSER_IDENTITY = {
  userCode: 9999,
  internalCode: "BROWSER",
  ip: "9.9.9.9",
};

const AGIL_IDENTITY_RIG_ENV_KEYS = [
  "AGIL_APIM_SUBSCRIPTION_KEY",
  "AGIL_IDENTITY_PATH",
  "AGIL_CHROME_USER_DATA_DIR",
  "AGIL_CHROME_PROFILE",
  "AGIL_BROWSER_URL",
  "AGIL_BROWSER_WS_ENDPOINT",
  "AGIL_CHROME_PROCESS_DISCOVERY",
  "AGIL_SCAN_ALL_CHROME_PROFILES",
  "AGIL_RAW_CHROME_STORAGE_FILE_SCAN",
  "AGIL_TEMP_CHROME_STORAGE_FALLBACK",
  "CHROME_USER_DATA_DIR",
  "COSTAMAR_CHROME_USER_DATA_DIR",
  "LOCALAPPDATA",
];

interface AgilIdentityRig {
  identityPath: string;
  mintedToken: string;
  mintedIdentities: Array<{ userCode?: number; internalCode?: string; ip?: string }>;
  searchAuthorizations: string[];
  readIdentityFile: () => unknown;
}

async function withAgilIdentityRig(
  options: {
    persistedIdentity?: { userCode: number; internalCode: string; ip: string };
    refuseMintForUserCode?: number;
  },
  run: (rig: AgilIdentityRig) => Promise<void>,
): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-agil-identity-"));
  const profileName = "Profile 40";
  const storageDir = join(tempRoot, profileName, "Local Storage", "leveldb");
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(
    join(tempRoot, "Local State"),
    JSON.stringify({
      profile: {
        last_used: profileName,
        last_active_profiles: [profileName],
        info_cache: {
          [profileName]: {},
        },
      },
    }),
    "utf8",
  );

  const browserUserPayload = Buffer.from(JSON.stringify({
    Usuario: {
      CodigoUsuario: AGIL_BROWSER_IDENTITY.userCode,
    },
    Cliente: {
      Vendedor: {
        CodigoVendedor: AGIL_BROWSER_IDENTITY.internalCode,
      },
    },
  })).toString("base64");
  const browserIpPayload = Buffer.from(AGIL_BROWSER_IDENTITY.ip).toString("base64");
  writeFileSync(
    join(storageDir, "000001.log"),
    `https://www.agilsmart.com/home-user\0tokenTravelC browser-token user_data ${browserUserPayload} ip ${browserIpPayload}`,
    "utf8",
  );

  const identityPath = join(tempRoot, "agil-identity.json");
  if (options.persistedIdentity) {
    writeFileSync(identityPath, JSON.stringify(options.persistedIdentity), "utf8");
  }

  const previousEnv = new Map<string, string | undefined>(
    AGIL_IDENTITY_RIG_ENV_KEYS.map((key) => [key, process.env[key]] as const),
  );
  const previousFetch = global.fetch;
  const mintedTokenPayload = Buffer.from(JSON.stringify({ exp: 1893459600 })).toString("base64url");
  const mintedToken = `header.${mintedTokenPayload}.signature`;
  const mintedIdentities: AgilIdentityRig["mintedIdentities"] = [];
  const searchAuthorizations: string[] = [];

  resetAgilSessionCacheForTests();
  resetAgilApimSubscriptionKeyCacheForTests();
  process.env.AGIL_APIM_SUBSCRIPTION_KEY = "test-subscription-key";
  process.env.AGIL_IDENTITY_PATH = identityPath;
  process.env.AGIL_CHROME_USER_DATA_DIR = tempRoot;
  process.env.AGIL_CHROME_PROFILE = profileName;
  process.env.AGIL_CHROME_PROCESS_DISCOVERY = "0";
  process.env.AGIL_SCAN_ALL_CHROME_PROFILES = "0";
  process.env.AGIL_RAW_CHROME_STORAGE_FILE_SCAN = "1";
  process.env.AGIL_TEMP_CHROME_STORAGE_FALLBACK = "0";
  process.env.LOCALAPPDATA = join(tempRoot, "isolated-localappdata");
  delete process.env.AGIL_BROWSER_URL;
  delete process.env.AGIL_BROWSER_WS_ENDPOINT;
  delete process.env.CHROME_USER_DATA_DIR;
  delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;

  global.fetch = (async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);

    if (url === "https://motorvuelos.expertiatravel.com/auth/api/auth/token") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        userCode?: number;
        internalCode?: string;
        caller?: { fromIP?: string };
      };
      mintedIdentities.push({
        userCode: body.userCode,
        internalCode: body.internalCode,
        ip: body.caller?.fromIP,
      });

      if (options.refuseMintForUserCode !== undefined && body.userCode === options.refuseMintForUserCode) {
        return new Response("", { status: 401 });
      }

      return new Response(JSON.stringify({ token: mintedToken }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "https://motorvuelos.expertiatravel.com/mv/start-search") {
      searchAuthorizations.push(headers.get("Authorization") ?? "");
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "https://motorvuelos.expertiatravel.com/mv/search") {
      searchAuthorizations.push(headers.get("Authorization") ?? "");
      const body = JSON.parse(String(init?.body ?? "{}")) as { gds?: number };
      return new Response(JSON.stringify({
        groups: body.gds === 0 ? [buildAgilOptionsGroup(false)] : [],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    await run({
      identityPath,
      mintedToken,
      mintedIdentities,
      searchAuthorizations,
      readIdentityFile: () => JSON.parse(readFileSync(identityPath, "utf8")) as unknown,
    });
  } finally {
    global.fetch = previousFetch;
    resetAgilSessionCacheForTests();
    resetAgilApimSubscriptionKeyCacheForTests();
    previousEnv.forEach((value, key) => restoreEnv(key, value));
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("Agil revalidates a stale session from the persisted identity without opening the browser", async () => {
  await withAgilIdentityRig({ persistedIdentity: AGIL_PERSISTED_IDENTITY }, async (rig) => {
    const now = Date.now();
    const expiresAtMs = now + (60 * 60 * 1000);
    const capturedAtMs = now - (5 * 60 * 1000);

    // Past the revalidate window, so the session is no longer reusable as-is.
    assert.equal(shouldReuseAgilSession({ expiresAtMs, capturedAtMs }, now), false);
    setAgilSessionForTests({
      token: "cached-token",
      expiresAtMs,
      capturedAtMs,
      ...AGIL_PERSISTED_IDENTITY,
    });

    const result = await searchLocalAgilExact(buildAgilExactRequest("one-way"));

    assert.equal(result.offers.length, 2);
    assert.deepEqual(rig.mintedIdentities, []);
    assert.ok(rig.searchAuthorizations.length > 0);
    assert.ok(rig.searchAuthorizations.every((value) => value === "Bearer cached-token"));
    assert.deepEqual(rig.readIdentityFile(), AGIL_PERSISTED_IDENTITY);
  });
});

test("Agil mints from the persisted identity when the cached token nears expiry, still without the browser", async () => {
  await withAgilIdentityRig({ persistedIdentity: AGIL_PERSISTED_IDENTITY }, async (rig) => {
    const now = Date.now();
    setAgilSessionForTests({
      token: "cached-token",
      expiresAtMs: now + 60_000,
      capturedAtMs: now - (5 * 60 * 1000),
      ...AGIL_PERSISTED_IDENTITY,
    });

    const result = await searchLocalAgilExact(buildAgilExactRequest("one-way"));

    assert.equal(result.offers.length, 2);
    assert.deepEqual(rig.mintedIdentities, [AGIL_PERSISTED_IDENTITY]);
    assert.ok(rig.searchAuthorizations.length > 0);
    assert.ok(rig.searchAuthorizations.every((value) => value === `Bearer ${rig.mintedToken}`));
    assert.deepEqual(rig.readIdentityFile(), AGIL_PERSISTED_IDENTITY);
  });
});

test("Agil still bootstraps from the browser when no identity file exists, and persists what it read", async () => {
  await withAgilIdentityRig({}, async (rig) => {
    assert.equal(existsSync(rig.identityPath), false);

    await prewarmLocalAgilSession();

    assert.deepEqual(rig.readIdentityFile(), AGIL_BROWSER_IDENTITY);
    assert.deepEqual(rig.mintedIdentities, [AGIL_BROWSER_IDENTITY]);
  });
});

test("Agil falls back to the browser when the persisted identity is refused", async () => {
  await withAgilIdentityRig({
    persistedIdentity: AGIL_PERSISTED_IDENTITY,
    refuseMintForUserCode: AGIL_PERSISTED_IDENTITY.userCode,
  }, async (rig) => {
    const result = await searchLocalAgilExact(buildAgilExactRequest("one-way"));

    assert.equal(result.offers.length, 2);
    assert.deepEqual(rig.mintedIdentities, [AGIL_PERSISTED_IDENTITY, AGIL_BROWSER_IDENTITY]);
    assert.deepEqual(rig.readIdentityFile(), AGIL_BROWSER_IDENTITY);
    assert.ok(rig.searchAuthorizations.length > 0);
    assert.ok(rig.searchAuthorizations.every((value) => value === `Bearer ${rig.mintedToken}`));
  });
});

function buildAgilOneWayGroupForGds(gds: number) {
  const flightNumber = 1000 + gds;
  return {
    id: `agil-gds-${gds}`,
    display: true,
    airline: { code: "UX", name: "Air Europa" },
    departure: [
      {
        segments: [
          buildAgilCandidate(
            flightNumber,
            "LIM",
            "MAD",
            "2026-05-21T08:00:00",
            "2026-05-21T16:00:00",
            flightNumber,
          ),
        ],
      },
    ],
    pricingInfo: {
      totalFare: 950 + gds,
      itinTotalFare: {
        validatingCarrier: "UX",
        fareBreakDowns: [
          {
            passengerType: { quantity: 1 },
            passengerFare: {
              baseFare: 700 + gds,
              taxes: 250,
              totalFare: 950 + gds,
              feeNMV: 0,
              feePTA: 0,
              dsctoTaxes: 0,
            },
          },
        ],
      },
      tipoCambio: {
        code: "USD",
        rate: 3.7531,
      },
    },
  };
}

async function withMockedAgilPerGdsSearch<T>(run: () => Promise<T>): Promise<T> {
  const previousFetch = global.fetch;
  const previousKey = process.env.AGIL_APIM_SUBSCRIPTION_KEY;

  resetAgilSessionCacheForTests();
  resetAgilApimSubscriptionKeyCacheForTests();
  process.env.AGIL_APIM_SUBSCRIPTION_KEY = "test-subscription-key";
  setAgilSessionForTests();
  global.fetch = (async (input, init) => {
    const url = String(input);

    if (url === "https://motorvuelos.expertiatravel.com/mv/start-search") {
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "https://motorvuelos.expertiatravel.com/mv/search") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { gds?: number };
      const gds = Number(body.gds ?? 0);
      return new Response(JSON.stringify({
        groups: [buildAgilOneWayGroupForGds(gds)],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    return await run();
  } finally {
    global.fetch = previousFetch;
    resetAgilSessionCacheForTests();
    resetAgilApimSubscriptionKeyCacheForTests();
    restoreEnv("AGIL_APIM_SUBSCRIPTION_KEY", previousKey);
  }
}

test("Agil progressive exact search grows its offers monotonically and ends where the plain search does", async () => {
  const request = buildAgilExactRequest("one-way");
  const progressCounts: number[] = [];

  const progressive = await withMockedAgilPerGdsSearch(async () =>
    resolveLocalAgilExactProgressive(request, (update) => {
      progressCounts.push(update.offers.length);
      assert.equal(update.partial, true);
    }));
  const plain = await withMockedAgilPerGdsSearch(async () => searchLocalAgilExact(request));

  // One update per GDS, each adding exactly the offers of the GDS that resolved.
  assert.equal(progressCounts.length, 7);
  assert.deepEqual(progressCounts, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(progressive.offers.length, 7);
  assert.equal(progressive.partial, false);
  assert.deepEqual(progressive.warnings, []);

  const sortedIds = (result: { offers: Array<{ id: string }> }) =>
    result.offers.map((offer) => offer.id).sort();
  assert.deepEqual(sortedIds(progressive), sortedIds(plain));
});

test("Agil progressive exact search keeps mapping the surviving GDS when one of them fails", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.AGIL_APIM_SUBSCRIPTION_KEY;
  const request = buildAgilExactRequest("one-way");
  const progressCounts: number[] = [];

  resetAgilSessionCacheForTests();
  resetAgilApimSubscriptionKeyCacheForTests();
  process.env.AGIL_APIM_SUBSCRIPTION_KEY = "test-subscription-key";
  setAgilSessionForTests();
  global.fetch = (async (input, init) => {
    const url = String(input);

    if (url === "https://motorvuelos.expertiatravel.com/mv/start-search") {
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "https://motorvuelos.expertiatravel.com/mv/search") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { gds?: number };
      const gds = Number(body.gds ?? 0);
      if (gds === 3) {
        return new Response("{}", { status: 503 });
      }

      return new Response(JSON.stringify({
        groups: [buildAgilOneWayGroupForGds(gds)],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const result = await resolveLocalAgilExactProgressive(request, (update) => {
      progressCounts.push(update.offers.length);
    });

    assert.equal(result.offers.length, 6);
    assert.equal(result.partial, true);
    assert.ok(result.warnings.some((warning) => /Agil GDS 3 omitted/.test(warning)));
    // The failed GDS still reports progress, but adds no offer to the memo, so
    // the offer count never decreases and repeats once for the omitted GDS.
    assert.equal(progressCounts.length, 7);
    assert.equal(progressCounts.at(-1), 6);
    progressCounts.forEach((count, index) => {
      assert.ok(index === 0 || count >= (progressCounts[index - 1] ?? 0));
    });
  } finally {
    global.fetch = previousFetch;
    resetAgilSessionCacheForTests();
    resetAgilApimSubscriptionKeyCacheForTests();
    restoreEnv("AGIL_APIM_SUBSCRIPTION_KEY", previousKey);
  }
});

const AGIL_GDS_ORDER_FOR_TESTS = [0, 1, 3, 7, 10, 21, 22];

interface DeferredAgilSearchCall {
  gds: number;
  settle: (error?: Error) => void;
}

async function flushAgilSearchQueue(): Promise<void> {
  // setImmediate keeps this cheap; the limiter hands slots over on microtasks,
  // so a handful of macrotask turns is enough to settle every admitted wave.
  for (let tick = 0; tick < 12; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface DeferredAgilSearchHarness {
  startedGds: number[];
  pending: DeferredAgilSearchCall[];
  maxObservedInFlight: () => number;
}

async function withDeferredAgilSearches<T>(
  maxInflight: string,
  run: (harness: DeferredAgilSearchHarness) => Promise<T>,
): Promise<T> {
  const previousFetch = global.fetch;
  const previousKey = process.env.AGIL_APIM_SUBSCRIPTION_KEY;
  const previousMaxInflight = process.env.AGIL_MAX_INFLIGHT_SEARCH_REQUESTS;

  resetAgilSessionCacheForTests();
  resetAgilApimSubscriptionKeyCacheForTests();
  resetAgilInflightLimiterForTests();
  process.env.AGIL_APIM_SUBSCRIPTION_KEY = "test-subscription-key";
  process.env.AGIL_MAX_INFLIGHT_SEARCH_REQUESTS = maxInflight;
  setAgilSessionForTests();

  const startedGds: number[] = [];
  const pending: DeferredAgilSearchCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  global.fetch = (async (input, init) => {
    const url = String(input);

    if (url === "https://motorvuelos.expertiatravel.com/mv/start-search") {
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "https://motorvuelos.expertiatravel.com/mv/search") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { gds?: number };
      const gds = Number(body.gds ?? -1);
      startedGds.push(gds);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);

      return await new Promise<Response>((resolve, reject) => {
        pending.push({
          gds,
          settle: (error?: Error) => {
            inFlight -= 1;
            if (error) {
              reject(error);
              return;
            }

            resolve(new Response(JSON.stringify({ groups: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }));
          },
        });
      });
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    return await run({
      startedGds,
      pending,
      maxObservedInFlight: () => maxInFlight,
    });
  } finally {
    global.fetch = previousFetch;
    resetAgilSessionCacheForTests();
    resetAgilApimSubscriptionKeyCacheForTests();
    resetAgilInflightLimiterForTests();
    restoreEnv("AGIL_APIM_SUBSCRIPTION_KEY", previousKey);
    restoreEnv("AGIL_MAX_INFLIGHT_SEARCH_REQUESTS", previousMaxInflight);
  }
}

test("Agil /mv/search calls never exceed the process-wide in-flight ceiling", async () => {
  await withDeferredAgilSearches("7", async (harness) => {
    assert.equal(AGIL_CONCURRENCY.maxInflightSearchRequests, 7);

    const first = searchLocalAgilExact(buildAgilExactRequest("one-way"));
    await flushAgilSearchQueue();
    // The first search alone already saturates the ceiling, so everything the
    // second one asks for has to queue behind it.
    assert.deepEqual(harness.startedGds, AGIL_GDS_ORDER_FOR_TESTS);

    const second = searchLocalAgilExact(buildAgilExactRequest("one-way"));
    await flushAgilSearchQueue();
    assert.equal(harness.startedGds.length, 7);
    assert.equal(readAgilInflightLimiterStateForTests().inFlight, 7);
    assert.equal(readAgilInflightLimiterStateForTests().queued, 7);

    for (let index = 0; index < 14; index += 1) {
      const call = harness.pending[index];
      assert.ok(call, `call ${index} should have started`);
      call.settle();
      await flushAgilSearchQueue();
      assert.ok(
        harness.maxObservedInFlight() <= 7,
        `in-flight peaked at ${harness.maxObservedInFlight()}`,
      );
      assert.equal(harness.startedGds.length, Math.min(14, 8 + index));
    }

    const [firstResult, secondResult] = await Promise.all([first, second]);

    // Every queued call was admitted in the order it asked for a slot: the
    // first search's whole wave, then the second search's whole wave.
    assert.deepEqual(harness.startedGds, [
      ...AGIL_GDS_ORDER_FOR_TESTS,
      ...AGIL_GDS_ORDER_FOR_TESTS,
    ]);
    assert.equal(harness.maxObservedInFlight(), 7);
    assert.equal(firstResult.offers.length, 0);
    assert.equal(secondResult.offers.length, 0);
    assert.equal(readAgilInflightLimiterStateForTests().inFlight, 0);
    assert.equal(readAgilInflightLimiterStateForTests().queued, 0);
  });
});

test("a rejected Agil /mv/search releases its in-flight slot", async () => {
  await withDeferredAgilSearches("7", async (harness) => {
    const first = searchLocalAgilExact(buildAgilExactRequest("one-way"));
    await flushAgilSearchQueue();
    const second = searchLocalAgilExact(buildAgilExactRequest("one-way"));
    await flushAgilSearchQueue();
    assert.equal(harness.startedGds.length, 7);

    harness.pending[0]?.settle(new Error("socket hang up"));
    await flushAgilSearchQueue();
    assert.equal(harness.startedGds.length, 8);

    for (let index = 1; index < 14; index += 1) {
      harness.pending[index]?.settle();
      await flushAgilSearchQueue();
    }

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(harness.startedGds.length, 14);
    assert.ok(harness.maxObservedInFlight() <= 7);
    assert.equal(firstResult.partial, true);
    assert.ok(firstResult.warnings.some((warning) => /GDS 0/.test(warning)));
    assert.equal(secondResult.offers.length, 0);
    assert.equal(readAgilInflightLimiterStateForTests().inFlight, 0);
  });
});
