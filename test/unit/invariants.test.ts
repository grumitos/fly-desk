import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveItineraryDurationMinutes, zonedMinutesBetween } from "../../src/core/flight-duration";
import type { CanonicalOffer, SearchRequest } from "../../src/core/types";
import { envFlag, envNumber } from "../../src/env";
import {
  DEFAULT_MIGRATION_CONCURRENT_MONTHS,
  DEFAULT_SEARCH_MAX_FUTURE_DAYS,
  deskIsoDate,
} from "../../src/core/runtime-config";
import { normalizeCostamarProviderContext } from "../../src/provider-context";
import { providerPrewarmIntervalMs } from "../../src/provider-prewarm";
import { getPublicRuntimeConfig, getSearchDatePolicy } from "../../src/search-date-policy";
import { SearchSessionStore } from "../../src/session-store";
import { resolveWebSessionMaxLifetimeSeconds, resolveWebSessionTtlSeconds } from "../../src/web-auth";

/*
 * Invariants that are cheap to state and expensive to get wrong: the desk's
 * calendar day, how settings fall back, which Click and Book Plus token is the
 * current one, how a journey is measured across time zones, and what the
 * deployment path is allowed to do.
 */

const repoRoot = join(import.meta.dir, "..", "..");
const savedEnv = { ...process.env };

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in savedEnv)) {
      delete process.env[name];
    }
  }
  Object.assign(process.env, savedEnv);
});

describe("dates", () => {
  test("today is Lima's calendar day, whatever the server clock says", () => {
    expect(deskIsoDate(new Date("2026-09-25T04:30:00Z"))).toBe("2026-09-24");
    expect(deskIsoDate(new Date("2026-09-25T05:00:00Z"))).toBe("2026-09-25");
  });

  test("the date override only applies to the test runtime", () => {
    process.env.SEARCH_TODAY_OVERRIDE = "2030-01-01";
    process.env.NODE_ENV = "test";
    expect(getSearchDatePolicy(new Date("2026-09-25T12:00:00Z")).minSearchDate).toBe("2030-01-01");
    process.env.NODE_ENV = "production";
    expect(getSearchDatePolicy(new Date("2026-09-25T12:00:00Z")).minSearchDate).toBe("2026-09-25");
  });
});

describe("settings", () => {
  test("an empty or malformed number falls back instead of becoming 0 or NaN", () => {
    for (const raw of [undefined, "", "   ", "20s", "NaN"]) {
      if (raw === undefined) {
        delete process.env.FLY_DESK_UNIT_NUMBER;
      } else {
        process.env.FLY_DESK_UNIT_NUMBER = raw;
      }
      expect(envNumber("FLY_DESK_UNIT_NUMBER", 1_000, { min: 0, max: 10_000 })).toBe(1_000);
    }
    process.env.FLY_DESK_UNIT_NUMBER = "50000";
    expect(envNumber("FLY_DESK_UNIT_NUMBER", 1_000, { min: 0, max: 10_000 })).toBe(10_000);
    process.env.FLY_DESK_UNIT_LEGACY = "250";
    expect(envNumber(["FLY_DESK_UNIT_MISSING", "FLY_DESK_UNIT_LEGACY"], 1_000)).toBe(250);
  });

  test("an empty setting keeps its default where the desk reads it", () => {
    for (const name of [
      "SEARCH_MAX_FUTURE_DAYS",
      "FLY_DESK_MIGRATION_CONCURRENT_MONTHS",
      "FLY_DESK_WEB_SESSION_TTL_SECONDS",
      "FLY_DESK_WEB_SESSION_MAX_LIFETIME_SECONDS",
      "FLY_DESK_PROVIDER_PREWARM_INTERVAL_MS",
    ]) {
      process.env[name] = "";
    }
    /* Read as 0, the window would be today alone, a session would last five
       minutes, and the periodic prewarm would stop. */
    const runtime = getPublicRuntimeConfig(new Date("2026-09-25T12:00:00Z"));
    expect(getSearchDatePolicy(new Date("2026-09-25T12:00:00Z")).maxFutureDays).toBe(DEFAULT_SEARCH_MAX_FUTURE_DAYS);
    expect(runtime.migrationConcurrentMonths).toBe(DEFAULT_MIGRATION_CONCURRENT_MONTHS);
    expect(resolveWebSessionTtlSeconds()).toBe(12 * 60 * 60);
    expect(resolveWebSessionMaxLifetimeSeconds()).toBe(7 * 24 * 60 * 60);
    expect(providerPrewarmIntervalMs()).toBe(10 * 60 * 1000);
  });

  test("an empty flag keeps its default", () => {
    process.env.FLY_DESK_UNIT_FLAG = "";
    expect(envFlag("FLY_DESK_UNIT_FLAG", false)).toBe(false);
    process.env.FLY_DESK_UNIT_FLAG = "0";
    expect(envFlag("FLY_DESK_UNIT_FLAG", true)).toBe(false);
    process.env.FLY_DESK_UNIT_FLAG = "1";
    expect(envFlag("FLY_DESK_UNIT_FLAG", false)).toBe(true);
  });
});

describe("Click and Book Plus token", () => {
  const tokenDir = mkdtempSync(join(tmpdir(), "fly-desk-unit-token-"));
  afterAll(() => rmSync(tokenDir, { recursive: true, force: true }));
  let tokenFiles = 0;

  /** A file of its own: the reader re-stats a path at most once a second. */
  function tokenFile(token: string): string {
    tokenFiles += 1;
    const path = join(tokenDir, `token-${tokenFiles}`);
    writeFileSync(path, `${token}\n`);
    return path;
  }

  function brandedToken(expiresInSeconds: number): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ exp })}.${"s".repeat(43)}`;
  }

  const configuredToken = () => normalizeCostamarProviderContext().token;

  test("a context with an empty token reads the configured one", () => {
    delete process.env.CBPLUS_TOKEN_FILE;
    process.env.CBPLUS_TOKEN = "configured-token";
    expect(normalizeCostamarProviderContext({ token: "" }).token).toBe("configured-token");
    expect(normalizeCostamarProviderContext({ token: "  " }).token).toBe("configured-token");
    expect(normalizeCostamarProviderContext({ token: "context-token" }).token).toBe("context-token");
  });

  test("a renewal in the file wins over the token the process started with", () => {
    const renewed = brandedToken(3_600);
    process.env.CBPLUS_TOKEN = brandedToken(600);
    process.env.CBPLUS_TOKEN_FILE = tokenFile(renewed);
    expect(configuredToken()).toBe(renewed);
  });

  test("after a platform rollback, the token renewed in the environment wins over a stale file", () => {
    const renewed = brandedToken(3_600);
    process.env.CBPLUS_TOKEN = renewed;
    process.env.CBPLUS_TOKEN_FILE = tokenFile(brandedToken(-600));
    expect(configuredToken()).toBe(renewed);
  });

  test("either source alone is enough, and a tie keeps the file", () => {
    const token = brandedToken(3_600);
    process.env.CBPLUS_TOKEN = "";
    process.env.CBPLUS_TOKEN_FILE = tokenFile(token);
    expect(configuredToken()).toBe(token);
    process.env.CBPLUS_TOKEN = token;
    process.env.CBPLUS_TOKEN_FILE = tokenFile("");
    expect(configuredToken()).toBe(token);
    process.env.CBPLUS_TOKEN = "opaque-environment-token";
    process.env.CBPLUS_TOKEN_FILE = tokenFile("opaque-file-token");
    expect(configuredToken()).toBe("opaque-file-token");
  });
});

describe("rollback", () => {
  test("a stored search job keeps the `offers` list an older release reads on boot", () => {
    const dir = mkdtempSync(join(tmpdir(), "fly-desk-unit-rows-"));
    const dbPath = join(dir, "sessions.sqlite");
    const offer = (id: string) => ({
      id,
      providerSource: "agil-local",
      price: { total: { amount: 100, currencyCode: "USD" } },
      purchasePaths: [],
    }) as unknown as CanonicalOffer;
    const request: SearchRequest = {
      tripType: "one-way",
      searchMode: "exact",
      legs: [{ origin: "LIM", destination: "CUZ", departureDate: "2026-12-01" }],
      passengers: { adults: 1, children: 0, infants: 0 },
      cabin: "ECONOMY",
      filters: {},
      coverageMode: "core",
      redirectMode: "best-effort",
      currencyCode: "USD",
    };
    try {
      const store = new SearchSessionStore({ dbPath });
      const job = store.createSearchJob({
        request,
        offers: [offer("second")],
        allOffers: [offer("first"), offer("second")],
        searchMeta: {
          requestedAt: "2026-09-25T12:00:00.000Z",
          completedAt: "2026-09-25T12:00:05.000Z",
          providersUsed: ["agil-local"],
          warnings: [],
          partial: false,
          searchState: "search_live",
        },
        providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
        warnings: [],
        sortMode: "cheapest",
        status: "completed",
      });
      store.close();

      /* A release that stores both lists maps over `offers` when it restores a
         row; without the list it cannot boot on rows written by this one. */
      const db = new Database(dbPath, { readonly: true });
      const rows = db.query("SELECT payload FROM search_jobs").all() as Array<{ payload: string }>;
      db.close();
      expect(rows.map((row) => Array.isArray((JSON.parse(row.payload) as { offers?: unknown }).offers))).toEqual([true]);

      const reopened = new SearchSessionStore({ dbPath });
      expect(reopened.getSearchJob(job.id)?.offers.map((entry) => entry.id)).toEqual(["second"]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("journey duration", () => {
  test("is measured on each airport's own clock", () => {
    // 01:10 in Lima (UTC-5) to 19:00 in Madrid (UTC+2 in May) is 10 h 50 min.
    expect(zonedMinutesBetween("LIM", "2026-05-21T01:10:00", "MAD", "2026-05-21T19:00:00")).toBe(650);
    // A provider that stamps -05:00 on Madrid's wall clock does not shorten it.
    expect(zonedMinutesBetween("LIM", "2026-05-21T01:10:00-05:00", "MAD", "2026-05-21T19:00:00-05:00")).toBe(650);
  });

  test("prefers the clocks over a provider figure that cannot hold a day", () => {
    const segments = [
      { origin: "LIM", destination: "BOG", departureAt: "2026-05-21T01:10:00", arrivalAt: "2026-05-21T04:40:00", durationMinutes: 210 },
      { origin: "BOG", destination: "MAD", departureAt: "2026-05-21T18:00:00", arrivalAt: "2026-05-22T11:00:00", durationMinutes: 600 },
    ];
    // Agil sends elapsed time as HHMM, so 26 h 50 min arrives as 0250.
    expect(resolveItineraryDurationMinutes(segments, [800], 170)).toBe(1_610);
  });
});

describe("deployment", () => {
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "deploy-vps.yml"), "utf8");

  test("ships only an exact main revision, built without secrets", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/\bpush:|\bpull_request:|\bschedule:/);
    expect(workflow).toContain("grep -Eq '^[0-9a-f]{40}$'");
    expect(workflow).toContain('git merge-base --is-ancestor "$REVISION" HEAD');
    const buildJob = workflow.slice(workflow.indexOf("  build_release:"), workflow.indexOf("  deploy:"));
    expect(buildJob).not.toContain("secrets.");
    expect(buildJob).toContain("git archive");
    expect(workflow).toContain("sha256sum --check --strict");
  });

  test("reaches the host only through pinned keys and the forced command set", () => {
    expect(workflow).not.toContain("ssh-keyscan");
    expect(workflow).toContain("StrictHostKeyChecking yes");
    expect(workflow).toContain("BatchMode yes");
    const remoteCommands = [...workflow.matchAll(/ssh vps-app "([a-z]+) /g)].map((match) => match[1]);
    expect(new Set(remoteCommands)).toEqual(new Set(["upload", "deploy", "verify", "rollback"]));
    expect(workflow.match(/environment: production/g)?.length).toBe(2);
  });

  test("prepares a release that carries its own dependencies", () => {
    const prepare = readFileSync(join(repoRoot, "deploy", "prepare-release.sh"), "utf8");
    expect(prepare).toContain("--frozen-lockfile");
    expect(prepare).toContain("--backend copyfile");
    expect(prepare).toContain("Release install is not self-contained");
    expect(prepare).toContain("test -f frontend/dist/index.html");
  });
});
