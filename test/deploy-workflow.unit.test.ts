import { test } from "bun:test";
import assert from "node:assert/strict";

async function deployWorkflow(): Promise<string> {
  return (await Bun.file(new URL("../.github/workflows/deploy-vps.yml", import.meta.url)).text()).replaceAll("\r\n", "\n");
}

function job(workflow: string, name: string, nextName?: string): string {
  const start = workflow.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `missing ${name} job`);
  const end = nextName ? workflow.indexOf(`  ${nextName}:\n`, start + 1) : workflow.length;
  assert.notEqual(end, -1, `missing ${nextName} job`);
  return workflow.slice(start, end);
}

test("deploy and rollback require a pinned VPS host key", async () => {
  const workflow = await deployWorkflow();

  assert.doesNotMatch(workflow, /\bssh-keyscan\b/);
  assert.equal(workflow.match(/secrets\.VPS_SSH_KNOWN_HOSTS_B64/g)?.length, 2);
  assert.equal(workflow.match(/ssh-keygen -F /g)?.length, 2);
  assert.equal(workflow.match(/StrictHostKeyChecking yes/g)?.length, 2);
  assert.equal(workflow.match(/BatchMode yes/g)?.length, 2);
  assert.equal(workflow.match(/IdentitiesOnly yes/g)?.length, 2);
});

test("deploy and rollback use only the forced command contract", async () => {
  const workflow = await deployWorkflow();

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
  const workflow = await deployWorkflow();

  assert.match(workflow, /ref: main/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /git merge-base --is-ancestor "\$REVISION" HEAD/);
  assert.match(workflow, /git checkout --detach "\$REVISION"/);
  assert.doesNotMatch(workflow, /git fetch/);
});

test("repository code runs only in the secretless build job", async () => {
  const workflow = await deployWorkflow();
  const build = job(workflow, "build_release", "deploy");
  const deploy = job(workflow, "deploy", "rollback");

  assert.doesNotMatch(build, /environment: production|secrets\.|Configure pinned SSH|\bssh vps-app\b/);
  assert.match(deploy, /needs: build_release/);
  assert.match(deploy, /environment: production/);
  assert.match(deploy, /actions\/download-artifact@/);
  assert.match(deploy, /sha256sum --check --strict/);
  assert.doesNotMatch(deploy, /actions\/checkout@|setup-bun@|setup-node@|bun (?:install|run)/);
});

test("release artifact is deterministic and contains only the exact revision plus built frontend", async () => {
  const workflow = await deployWorkflow();

  assert.match(workflow, /git archive --format=tar --prefix=app\/ "\$REVISION"/);
  assert.match(workflow, /cp -R frontend\/dist package\/app\/frontend\/dist/);
  assert.match(workflow, /printf '%s\\n' "\$REVISION" > package\/app\/REVISION/);
  assert.match(workflow, /--sort=name/);
  assert.match(workflow, /--mtime='UTC 1970-01-01'/);
  assert.match(workflow, /--owner=0/);
  assert.match(workflow, /--group=0/);
  assert.match(workflow, /--numeric-owner/);
  assert.match(workflow, /gzip -n > fly-desk\.tar\.gz/);
  assert.doesNotMatch(workflow, /\brsync\b|tar .* -czf/);
});

test("release preparation copies dependencies out of the Bun cache", async () => {
  const prepareRelease = await Bun.file(new URL("../deploy/prepare-release.sh", import.meta.url)).text();

  assert.match(prepareRelease, /^"\$bun_bin" install --frozen-lockfile --backend copyfile\r?$/m);
});
