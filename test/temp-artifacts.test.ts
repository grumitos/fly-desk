import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupPrefixedTempArtifacts } from "../src/temp-artifacts";

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

    rmSync(tempRoot, { recursive: true, force: true });
  }
});
