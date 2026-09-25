import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveItineraryDurationMinutes, zonedMinutesBetween } from "../../src/core/flight-duration";
import { envFlag, envNumber } from "../../src/env";
import { deskIsoDate, getSearchDatePolicy } from "../../src/search-date-policy";

/*
 * Invariants that are cheap to state and expensive to get wrong: the desk's
 * calendar day, how settings fall back, how a journey is measured across time
 * zones, and what the deployment path is allowed to do.
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

  test("an empty flag keeps its default", () => {
    process.env.FLY_DESK_UNIT_FLAG = "";
    expect(envFlag("FLY_DESK_UNIT_FLAG", false)).toBe(false);
    process.env.FLY_DESK_UNIT_FLAG = "0";
    expect(envFlag("FLY_DESK_UNIT_FLAG", true)).toBe(false);
    process.env.FLY_DESK_UNIT_FLAG = "1";
    expect(envFlag("FLY_DESK_UNIT_FLAG", false)).toBe(true);
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
