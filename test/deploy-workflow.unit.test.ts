import { test } from "bun:test";
import assert from "node:assert/strict";

test("deploy and rollback require a pinned VPS host key", async () => {
  const workflow = await Bun.file(new URL("../.github/workflows/deploy-vps.yml", import.meta.url)).text();

  assert.doesNotMatch(workflow, /\bssh-keyscan\b/);
  assert.equal(workflow.match(/secrets\.VPS_SSH_KNOWN_HOSTS_B64/g)?.length, 2);
  assert.equal(workflow.match(/ssh-keygen -F /g)?.length, 2);
  assert.equal(workflow.match(/StrictHostKeyChecking yes/g)?.length, 2);
  assert.equal(workflow.match(/BatchMode yes/g)?.length, 2);
  assert.equal(workflow.match(/IdentitiesOnly yes/g)?.length, 2);
});

test("deploy and rollback only invoke the fixed platform release wrapper", async () => {
  const workflow = await Bun.file(new URL("../.github/workflows/deploy-vps.yml", import.meta.url)).text();

  assert.match(workflow, /RELEASE_WRAPPER: \/usr\/local\/bin\/vps-release-fly-desk/);
  assert.match(workflow, /sudo -n '\$RELEASE_WRAPPER' deploy '\$REVISION' '\$ARTIFACT_DIGEST'/);
  assert.match(workflow, /sudo -n '\$RELEASE_WRAPPER' rollback '\$REVISION'/);
  assert.match(workflow, /incoming\/\$APP_NAME\/\$REVISION/);
  assert.doesNotMatch(workflow, /bash -s --/);
  assert.doesNotMatch(workflow, /rsync -a --delete "\$release_dir"/);
});

test("deploy proves an exact main revision without retained checkout credentials", async () => {
  const workflow = await Bun.file(new URL("../.github/workflows/deploy-vps.yml", import.meta.url)).text();

  assert.match(workflow, /ref: main/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /git merge-base --is-ancestor "\$REVISION" HEAD/);
  assert.match(workflow, /git checkout --detach "\$REVISION"/);
  assert.doesNotMatch(workflow, /git fetch/);
});
