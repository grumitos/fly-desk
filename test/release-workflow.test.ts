import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("release workflow builds, uploads, and verifies the VPS update channel", () => {
  const workflow = readFileSync(
    join(process.cwd(), ".github", "workflows", "release.yml"),
    "utf8",
  );

  for (const requiredSnippet of [
    "workflow_dispatch",
    "bun run typecheck",
    "bun run lint",
    "bun run test",
    "bun run build:frontend",
    "bun run build:exe",
    "bun run package:release",
    "FLY_DESK_VPS_HOST",
    "FLY_DESK_VPS_USER",
    "FLY_DESK_VPS_SSH_KEY",
    "FLY_DESK_UPDATE_BASE_URL",
    "FLY_DESK_UPDATE_TOKEN",
    "/srv/fly-desk-updates/releases",
    "/srv/fly-desk-updates/channels",
    "latest.json.tmp",
    "latest.json",
    "X-FlyDesk-Update-Token",
  ]) {
    assert.match(workflow, new RegExp(requiredSnippet.replaceAll("/", "\\/")));
  }
});
