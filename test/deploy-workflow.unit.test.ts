import { test } from "bun:test";
import assert from "node:assert/strict";

test("deploy and rollback require a pinned VPS host key", async () => {
  const workflow = await Bun.file(new URL("../.github/workflows/deploy-vps.yml", import.meta.url)).text();

  assert.doesNotMatch(workflow, /\bssh-keyscan\b/);
  assert.equal(workflow.match(/secrets\.FLY_DESK_VPS_KNOWN_HOSTS/g)?.length, 2);
  assert.equal(workflow.match(/ssh-keygen -F /g)?.length, 2);
  assert.equal(workflow.match(/StrictHostKeyChecking=yes/g)?.length, 3);
});

test("deploy and rollback coordinate with Fly Desk maintenance", async () => {
  const workflow = await Bun.file(new URL("../.github/workflows/deploy-vps.yml", import.meta.url)).text();

  assert.equal(workflow.match(/operation_lock_file="\/run\/fly-desk-operation\.lock"/g)?.length, 2);
  assert.equal(workflow.match(/command -v flock/g)?.length, 2);
  assert.equal(workflow.match(/flock -w 300 9/g)?.length, 2);
});
