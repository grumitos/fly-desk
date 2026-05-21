import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProviderContextAsync,
  buildProviderContext,
  DEFAULT_COSTAMAR_API_BASE_URL,
  DEFAULT_COSTAMAR_BRAND_BASE_URL,
  DEFAULT_COSTAMAR_TERMINAL_ID,
  getCostamarChromeSessionScanCountForTests,
  inspectCostamarBrandedToken,
  normalizeCostamarProviderContext,
  resetCostamarSessionCacheForTests,
  resolveLatestCostamarProviderContext,
  resolveCostamarProviderContext,
} from "../src/provider-context";
import type { ProviderConfigInput } from "../src/core/types";

function buildJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

test("inspectCostamarBrandedToken classifies missing, expired, near-expiry, wrong-terminal and opaque tokens", () => {
  const nowMs = 1893456000000;
  const freshToken = buildJwt({
    id: "0721808110",
    iat: 1893455900,
    exp: 1893459600,
  });
  const nearExpiryToken = buildJwt({
    id: "0721808110",
    iat: 1893455900,
    exp: 1893456060,
  });
  const expiredToken = buildJwt({
    id: "0721808110",
    iat: 1893455000,
    exp: 1893455999,
  });
  const wrongTerminalToken = buildJwt({
    id: "9999999999",
    iat: 1893455900,
    exp: 1893459600,
  });

  assert.equal(inspectCostamarBrandedToken(undefined, "0721808110", nowMs).reason, "missing");
  assert.equal(inspectCostamarBrandedToken(freshToken, "0721808110", nowMs).reason, "usable");
  assert.equal(inspectCostamarBrandedToken(nearExpiryToken, "0721808110", nowMs).reason, "near-expiry");
  assert.equal(inspectCostamarBrandedToken(expiredToken, "0721808110", nowMs).reason, "expired");
  assert.equal(inspectCostamarBrandedToken(wrongTerminalToken, "0721808110", nowMs).reason, "terminal-mismatch");
  assert.deepEqual(
    inspectCostamarBrandedToken("opaque-token", "0721808110", nowMs),
    {
      token: "opaque-token",
      hasToken: true,
      opaque: true,
      terminalMatches: true,
      expired: false,
      usable: true,
      nearExpiry: false,
      reason: "opaque",
    },
  );
});

test("buildProviderContext ignores request-scoped Costamar base urls", () => {
  const context = buildProviderContext("costamar", {
    costamar: {
      terminalId: "0721808110",
      token: "super-secret-token",
      lang: "es",
      apiBaseUrl: "https://malicious.example/internal",
      brandBaseUrl: "https://evil.example/redirect",
    },
  } as unknown as ProviderConfigInput);

  assert.equal(context?.costamar?.apiBaseUrl, DEFAULT_COSTAMAR_API_BASE_URL);
  assert.equal(context?.costamar?.brandBaseUrl, DEFAULT_COSTAMAR_BRAND_BASE_URL);
  assert.equal(context?.costamar?.terminalId, "0721808110");
  assert.equal(context?.costamar?.token, "super-secret-token");
  assert.equal(context?.costamar?.lang, "es");
});

test("normalizeCostamarProviderContext rejects unapproved api hosts from env", () => {
  const previous = process.env.COSTAMAR_API_BASE_URL;
  process.env.COSTAMAR_API_BASE_URL = "https://example.com/vuelos/api";

  try {
    assert.throws(
      () => normalizeCostamarProviderContext(),
      /COSTAMAR_API_BASE_URL must use https and an approved host\./,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.COSTAMAR_API_BASE_URL;
    } else {
      process.env.COSTAMAR_API_BASE_URL = previous;
    }
  }
});

test("buildProviderContextAsync coalesces concurrent Costamar scans in-flight", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-inflight-dedup-"));
  const profileName = "Profile 90";
  const sessionsDir = join(tempRoot, profileName, "Sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const token = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  writeFileSync(
    join(sessionsDir, "Tabs_1"),
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${token}`,
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();

  try {
    const contexts = await Promise.all([
      buildProviderContextAsync("costamar", { costamar: { terminalId: "0721808110", lang: "es" } }),
      buildProviderContextAsync("costamar", { costamar: { terminalId: "0721808110", lang: "es" } }),
      buildProviderContextAsync("costamar", { costamar: { terminalId: "0721808110", lang: "es" } }),
      buildProviderContextAsync("costamar", { costamar: { terminalId: "0721808110", lang: "es" } }),
    ]);

    contexts.forEach((context) => {
      assert.equal(context?.costamar?.terminalId, "0721808110");
      assert.equal(context?.costamar?.token, token);
    });
    assert.equal(getCostamarChromeSessionScanCountForTests(), 1);
  } finally {
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveCostamarProviderContext reads Current Session files from Chrome sessions", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-current-session-"));
  const profileName = "Profile 60";
  const sessionsDir = join(tempRoot, profileName, "Sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const token = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  writeFileSync(
    join(sessionsDir, "Current Session"),
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${token}`,
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();

  try {
    const context = resolveCostamarProviderContext({ lang: "es" });
    assert.equal(context.terminalId, "0721808110");
    assert.equal(context.token, token);
  } finally {
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveCostamarProviderContext falls back to other Chrome profiles when the configured one has no usable token", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-profile-fallback-"));
  const configuredProfileName = "Profile 61";
  const fallbackProfileName = "Profile 62";
  const configuredSessionsDir = join(tempRoot, configuredProfileName, "Sessions");
  const fallbackSessionsDir = join(tempRoot, fallbackProfileName, "Sessions");
  mkdirSync(configuredSessionsDir, { recursive: true });
  mkdirSync(fallbackSessionsDir, { recursive: true });

  const expiredToken = buildJwt({
    id: "0721808110",
    iat: 1700000000,
    exp: 1700003600,
  });
  const freshToken = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  writeFileSync(
    join(configuredSessionsDir, "Tabs_1"),
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${expiredToken}`,
    "utf8",
  );
  writeFileSync(
    join(fallbackSessionsDir, "Tabs_1"),
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-15/2026-06-22/1/0/0?terminalId=0721808110&lang=es&token=${freshToken}`,
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = configuredProfileName;
  resetCostamarSessionCacheForTests();

  try {
    const context = resolveCostamarProviderContext({ lang: "es" });
    assert.equal(context.terminalId, "0721808110");
    assert.equal(context.token, freshToken);
  } finally {
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveLatestCostamarProviderContext prefers the repo-local Costamar agent profile when present", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-agent-profile-"));
  const sessionsDir = join(tempRoot, "profiles", "costamar-agent", "Profile 70", "Sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const token = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  writeFileSync(
    join(sessionsDir, "Tabs_1"),
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${token}`,
    "utf8",
  );

  const previousCwd = process.cwd();
  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousAgentUserDataDir = process.env.COSTAMAR_AGENT_CHROME_USER_DATA_DIR;
  const previousAgilUserDataDir = process.env.AGIL_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  const previousAgilProfile = process.env.AGIL_CHROME_PROFILE;
  delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  delete process.env.COSTAMAR_AGENT_CHROME_USER_DATA_DIR;
  delete process.env.AGIL_CHROME_USER_DATA_DIR;
  delete process.env.COSTAMAR_CHROME_PROFILE;
  delete process.env.AGIL_CHROME_PROFILE;
  process.chdir(tempRoot);
  resetCostamarSessionCacheForTests();

  try {
    const context = resolveLatestCostamarProviderContext({
      terminalId: "0721808110",
      lang: "es",
    });

    assert.equal(context.terminalId, "0721808110");
    assert.equal(context.token, token);
  } finally {
    process.chdir(previousCwd);
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousAgentUserDataDir === undefined) {
      delete process.env.COSTAMAR_AGENT_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_AGENT_CHROME_USER_DATA_DIR = previousAgentUserDataDir;
    }

    if (previousAgilUserDataDir === undefined) {
      delete process.env.AGIL_CHROME_USER_DATA_DIR;
    } else {
      process.env.AGIL_CHROME_USER_DATA_DIR = previousAgilUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    if (previousAgilProfile === undefined) {
      delete process.env.AGIL_CHROME_PROFILE;
    } else {
      process.env.AGIL_CHROME_PROFILE = previousAgilProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveLatestCostamarProviderContext falls back across Chrome user-data roots when the agent profile has no usable token", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-agent-root-fallback-"));
  const dedicatedSessionsDir = join(tempRoot, "profiles", "costamar-agent", "Profile 71", "Sessions");
  const fallbackSessionsDir = join(tempRoot, "agil-user-data", "Profile 72", "Sessions");
  mkdirSync(dedicatedSessionsDir, { recursive: true });
  mkdirSync(fallbackSessionsDir, { recursive: true });

  const expiredToken = buildJwt({
    id: "0721808110",
    iat: 1700000000,
    exp: 1700003600,
  });
  const freshToken = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  writeFileSync(
    join(dedicatedSessionsDir, "Tabs_1"),
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${expiredToken}`,
    "utf8",
  );
  writeFileSync(
    join(fallbackSessionsDir, "Tabs_1"),
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-15/2026-06-22/1/0/0?terminalId=0721808110&lang=es&token=${freshToken}`,
    "utf8",
  );

  const previousCwd = process.cwd();
  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousAgentUserDataDir = process.env.COSTAMAR_AGENT_CHROME_USER_DATA_DIR;
  const previousAgilUserDataDir = process.env.AGIL_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  const previousAgilProfile = process.env.AGIL_CHROME_PROFILE;
  delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  delete process.env.COSTAMAR_AGENT_CHROME_USER_DATA_DIR;
  process.env.AGIL_CHROME_USER_DATA_DIR = join(tempRoot, "agil-user-data");
  delete process.env.COSTAMAR_CHROME_PROFILE;
  delete process.env.AGIL_CHROME_PROFILE;
  process.chdir(tempRoot);
  resetCostamarSessionCacheForTests();

  try {
    const context = resolveLatestCostamarProviderContext({
      terminalId: "0721808110",
      lang: "es",
    });

    assert.equal(context.terminalId, "0721808110");
    assert.equal(context.token, freshToken);
  } finally {
    process.chdir(previousCwd);
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousAgentUserDataDir === undefined) {
      delete process.env.COSTAMAR_AGENT_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_AGENT_CHROME_USER_DATA_DIR = previousAgentUserDataDir;
    }

    if (previousAgilUserDataDir === undefined) {
      delete process.env.AGIL_CHROME_USER_DATA_DIR;
    } else {
      process.env.AGIL_CHROME_USER_DATA_DIR = previousAgilUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    if (previousAgilProfile === undefined) {
      delete process.env.AGIL_CHROME_PROFILE;
    } else {
      process.env.AGIL_CHROME_PROFILE = previousAgilProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveLatestCostamarProviderContext ignores Costamar URLs planted in browser origin storage", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-origin-poison-"));
  const profileName = "Profile 64";
  const sessionsDir = join(tempRoot, profileName, "Sessions");
  const levelDbDir = join(tempRoot, profileName, "Local Storage", "leveldb");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(levelDbDir, { recursive: true });

  const legitimateToken = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  const forgedToken = buildJwt({
    id: "0721808110",
    iat: 1893460000,
    exp: 1893467200,
  });

  writeFileSync(
    join(sessionsDir, "Tabs_1"),
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/1/0/0?terminalId=0721808110&lang=es&token=${legitimateToken}`,
    "utf8",
  );
  writeFileSync(
    join(levelDbDir, "000003.ldb"),
    `https://attacker.example/\0https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/1/0/0?terminalId=0721808110&lang=es&token=${forgedToken}`,
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();

  try {
    const context = resolveLatestCostamarProviderContext({
      terminalId: "0721808110",
      lang: "es",
    });

    assert.equal(context.token, legitimateToken);
  } finally {
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveLatestCostamarProviderContext bypasses the cached token when it is close to expiring", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-refresh-window-"));
  const profileName = "Profile 63";
  const sessionsDir = join(tempRoot, profileName, "Sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const nearExpiryToken = buildJwt({
    id: "0721808110",
    iat: nowSeconds - 60,
    exp: nowSeconds + 60,
  });
  const freshToken = buildJwt({
    id: "0721808110",
    iat: nowSeconds + 10,
    exp: nowSeconds + 3600,
  });
  const sessionFile = join(sessionsDir, "Tabs_1");
  writeFileSync(
    sessionFile,
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${nearExpiryToken}`,
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();

  try {
    const cached = resolveLatestCostamarProviderContext({
      terminalId: "0721808110",
      token: nearExpiryToken,
      lang: "es",
    });
    assert.equal(cached.token, nearExpiryToken);

    writeFileSync(
      sessionFile,
      `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-15/2026-06-22/1/0/0?terminalId=0721808110&lang=es&token=${freshToken}`,
      "utf8",
    );

    const refreshed = resolveLatestCostamarProviderContext({
      terminalId: "0721808110",
      token: nearExpiryToken,
      lang: "es",
    });
    assert.equal(refreshed.token, freshToken);
  } finally {
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("normalizeCostamarProviderContext rejects non-https brand urls from env", () => {
  const previous = process.env.COSTAMAR_BRAND_BASE_URL;
  process.env.COSTAMAR_BRAND_BASE_URL = "http://booking.clickandbook.com/vuelos";

  try {
    assert.throws(
      () => normalizeCostamarProviderContext(),
      /COSTAMAR_BRAND_BASE_URL must use https and an approved host\./,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.COSTAMAR_BRAND_BASE_URL;
    } else {
      process.env.COSTAMAR_BRAND_BASE_URL = previous;
    }
  }
});

test("normalizeCostamarProviderContext falls back to the default Costamar terminal", () => {
  const previous = process.env.COSTAMAR_TERMINAL_ID;
  delete process.env.COSTAMAR_TERMINAL_ID;

  try {
    const context = normalizeCostamarProviderContext();
    assert.equal(context.terminalId, DEFAULT_COSTAMAR_TERMINAL_ID);
  } finally {
    if (previous === undefined) {
      delete process.env.COSTAMAR_TERMINAL_ID;
    } else {
      process.env.COSTAMAR_TERMINAL_ID = previous;
    }
  }
});
