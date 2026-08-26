import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupPrefixedTempArtifacts,
  registerActiveTempArtifact,
  TEMP_ARTIFACT_ACTIVE_MARKER_NAME,
  TEMP_ARTIFACT_SWEEP_MIN_AGE_MS,
  unregisterActiveTempArtifact,
} from "../src/temp-artifacts";
import { removeTempRoot } from "./helpers/temp";

test("cleanupPrefixedTempArtifacts removes known temp artifacts without touching unrelated files", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "fly-desk-temp-artifacts-"));
  const previousTemp = process.env.TEMP;
  const previousTmp = process.env.TMP;

  process.env.TEMP = tempRoot;
  process.env.TMP = tempRoot;

  const agilProfile = join(tempRoot, "travel_quote_foundation_agil_test");
  const playwrightProfile = join(tempRoot, "playwright-report-temp");
  const cookieArtifact = join(tempRoot, "flydesk-cookie-session.txt");
  const unrelatedFile = join(tempRoot, "keep-me.txt");
  const rateCacheFile = join(tempRoot, "flydesk-quotation-usd-pen-rate.json");

  mkdirSync(agilProfile, { recursive: true });
  mkdirSync(playwrightProfile, { recursive: true });
  writeFileSync(join(agilProfile, "Preferences"), "{}");
  writeFileSync(join(playwrightProfile, "trace.zip"), "trace");
  writeFileSync(cookieArtifact, "cookie");
  writeFileSync(unrelatedFile, "keep");
  writeFileSync(rateCacheFile, "{\"day\":\"2026-04-09\",\"rate\":3.7}");

  try {
    await cleanupPrefixedTempArtifacts();

    assert.equal(existsSync(agilProfile), false);
    assert.equal(existsSync(playwrightProfile), false);
    assert.equal(existsSync(cookieArtifact), false);
    assert.equal(existsSync(unrelatedFile), true);
    assert.equal(existsSync(rateCacheFile), true);
  } finally {
    if (previousTemp === undefined) {
      delete process.env.TEMP;
    } else {
      process.env.TEMP = previousTemp;
    }

    if (previousTmp === undefined) {
      delete process.env.TMP;
    } else {
      process.env.TMP = previousTmp;
    }

    removeTempRoot(tempRoot);
  }
});

test("cleanupPrefixedTempArtifacts only removes stale inactive artifacts during periodic sweeps", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "fly-desk-temp-artifacts-aged-"));
  const previousTemp = process.env.TEMP;
  const previousTmp = process.env.TMP;
  process.env.TEMP = tempRoot;
  process.env.TMP = tempRoot;

  const staleAgil = join(tempRoot, "travel_quote_foundation_agil_stale");
  const freshAgil = join(tempRoot, "travel_quote_foundation_agil_fresh");
  const activeCostamar = join(tempRoot, "travel_quote_foundation_costamar_browser_active");

  mkdirSync(staleAgil, { recursive: true });
  mkdirSync(freshAgil, { recursive: true });
  mkdirSync(activeCostamar, { recursive: true });
  writeFileSync(join(staleAgil, "Preferences"), "{}");
  writeFileSync(join(freshAgil, "Preferences"), "{}");
  writeFileSync(join(activeCostamar, "Preferences"), "{}");

  const staleTime = new Date(Date.now() - TEMP_ARTIFACT_SWEEP_MIN_AGE_MS - 60_000);
  utimesSync(staleAgil, staleTime, staleTime);
  utimesSync(join(staleAgil, "Preferences"), staleTime, staleTime);

  registerActiveTempArtifact(activeCostamar);

  try {
    await cleanupPrefixedTempArtifacts(undefined, { olderThanMs: TEMP_ARTIFACT_SWEEP_MIN_AGE_MS });

    assert.equal(existsSync(staleAgil), false);
    assert.equal(existsSync(freshAgil), true);
    assert.equal(existsSync(activeCostamar), true);
  } finally {
    unregisterActiveTempArtifact(activeCostamar);

    if (previousTemp === undefined) {
      delete process.env.TEMP;
    } else {
      process.env.TEMP = previousTemp;
    }

    if (previousTmp === undefined) {
      delete process.env.TMP;
    } else {
      process.env.TMP = previousTmp;
    }

    removeTempRoot(tempRoot);
  }
});

test("cleanupPrefixedTempArtifacts preserves artifacts marked as active by another live process", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "fly-desk-temp-artifacts-marker-"));
  const previousTemp = process.env.TEMP;
  const previousTmp = process.env.TMP;
  process.env.TEMP = tempRoot;
  process.env.TMP = tempRoot;

  const markedArtifact = join(tempRoot, "travel_quote_foundation_costamar_browser_marked");
  const staleArtifact = join(tempRoot, "travel_quote_foundation_costamar_stale");
  mkdirSync(markedArtifact, { recursive: true });
  mkdirSync(staleArtifact, { recursive: true });
  writeFileSync(join(markedArtifact, "Preferences"), "{}");
  writeFileSync(join(staleArtifact, "Preferences"), "{}");
  writeFileSync(join(markedArtifact, TEMP_ARTIFACT_ACTIVE_MARKER_NAME), JSON.stringify({
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  }));

  const staleTime = new Date(Date.now() - TEMP_ARTIFACT_SWEEP_MIN_AGE_MS - 60_000);
  utimesSync(markedArtifact, staleTime, staleTime);
  utimesSync(join(markedArtifact, "Preferences"), staleTime, staleTime);
  utimesSync(staleArtifact, staleTime, staleTime);
  utimesSync(join(staleArtifact, "Preferences"), staleTime, staleTime);

  try {
    await cleanupPrefixedTempArtifacts(undefined, { olderThanMs: TEMP_ARTIFACT_SWEEP_MIN_AGE_MS });

    assert.equal(existsSync(markedArtifact), true);
    assert.equal(existsSync(staleArtifact), false);
  } finally {
    if (previousTemp === undefined) {
      delete process.env.TEMP;
    } else {
      process.env.TEMP = previousTemp;
    }

    if (previousTmp === undefined) {
      delete process.env.TMP;
    } else {
      process.env.TMP = previousTmp;
    }

    removeTempRoot(tempRoot);
  }
});
