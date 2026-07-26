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

test("deploy and rollback use only the forced command contract", async () => {
  const workflow = await Bun.file(new URL("../.github/workflows/deploy-vps.yml", import.meta.url)).text();

  assert.match(workflow, /ssh vps-app "upload \$REVISION \$ARTIFACT_DIGEST" < "\$ARTIFACT_PATH"/);
  assert.match(workflow, /ssh vps-app "deploy \$REVISION \$ARTIFACT_DIGEST"/);
  assert.match(workflow, /ssh vps-app "rollback \$REVISION"/);
  assert.equal(workflow.match(/ssh vps-app "verify \$REVISION"/g)?.length, 2);
  assert.equal(workflow.match(/^\s*ssh(?!-)\s/gm)?.length, 5);
  assert.equal(workflow.match(/ssh vps-app "(?:upload \$REVISION \$ARTIFACT_DIGEST|deploy \$REVISION \$ARTIFACT_DIGEST|rollback \$REVISION|verify \$REVISION)"/g)?.length, 5);
  for (const forbidden of [
    /\bscp\b/,
    /\/var\/lib\/vps-app-release\/incoming/,
    /\/usr\/local\/bin\/vps-release-/,
    /sudo -n/,
    /readlink \/opt\//,
    /curl .*http:\/\/127\.0\.0\.1:/,
    /bash -s --/,
  ])
    assert.doesNotMatch(workflow, forbidden);
});

test("deploy proves an exact main revision without retained checkout credentials", async () => {
  const workflow = await Bun.file(new URL("../.github/workflows/deploy-vps.yml", import.meta.url)).text();

  assert.match(workflow, /ref: main/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /git merge-base --is-ancestor "\$REVISION" HEAD/);
  assert.match(workflow, /git checkout --detach "\$REVISION"/);
  assert.doesNotMatch(workflow, /git fetch/);
});
