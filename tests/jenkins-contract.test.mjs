import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [pipeline, verify, gate, localDeploy, docs, checks] = await Promise.all([
  readFile(new URL('../Jenkinsfile', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/verify-candidate.sh', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/resource-gate.sh', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/deploy-local.sh', import.meta.url), 'utf8'),
  readFile(new URL('../RUNBOOK.md', import.meta.url), 'utf8'),
  readFile(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8'),
]);

test('Jenkins is main-only, lightweight, single-concurrency CD', () => {
  assert.match(pipeline, /agent \{ label 'plane-game-cd-rootless' \}/);
  assert.match(pipeline, /disableConcurrentBuilds\(abortPrevious: false\)/);
  assert.match(pipeline, /lock\(resource: 'plane-game-production-cd'/);
  assert.match(pipeline, /env[.]BRANCH_NAME != 'main' \|\| env[.]CHANGE_ID/);
  assert.match(pipeline, /git rev-parse FETCH_HEAD/);
  assert.match(pipeline, /verify-candidate[.]sh/);
  assert.match(pipeline, /resource-gate[.]sh/);
  for (const forbidden of ['pnpm ', 'playwright', 'docker build', 'docker push']) {
    assert.doesNotMatch(pipeline.toLowerCase(), new RegExp(forbidden));
  }
});

test('webhook metadata is verified against a successful trusted Actions main run and artifact', () => {
  for (const field of [
    '.name == "Checks"',
    '.path == ".github/workflows/checks.yml"',
    '.event == "push"',
    '.head_branch == "main"',
    '.status == "completed"',
    '.conclusion == "success"',
    '.repository.full_name == $repository',
    '.head_repository.full_name == $repository',
  ]) {
    assert.ok(verify.includes(field), `missing trusted-run assertion: ${field}`);
  }
  assert.match(verify, /release-candidate-\$sha/);
  assert.match(verify, /Expected exactly one unexpired release candidate artifact/);
  assert.match(verify, /git\/ref\/heads\/main/);
  assert.match(verify, /Protected main moved; stale candidate rejected/);
  assert.match(verify, /image_digest.*sha256/s);
});

test('GHCR pull uses a distinct sustainable read credential and temporary Docker config', () => {
  assert.match(pipeline, /plane-github-actions-read/);
  assert.match(pipeline, /plane-ghcr-pull/);
  assert.match(localDeploy, /GHCR_USER/);
  assert.match(localDeploy, /GHCR_TOKEN/);
  assert.match(localDeploy, /mktemp -d .*docker-auth/);
  assert.match(localDeploy, /trap cleanup EXIT/);
  assert.match(localDeploy, /docker pull "\$repository@\$digest"/);
  assert.match(localDeploy, /expected_version=\$\(printf '\{"sha":"%s"\}' "\$sha"\)/);
  assert.match(localDeploy, /deploy\/promote[.]sh/);
  assert.doesNotMatch(`${pipeline}\n${verify}\n${gate}\n${localDeploy}\n${docs}`, /ACR_|aliyuncs/i);
  assert.doesNotMatch(localDeploy, /GITHUB_TOKEN/);
});

test('same-host executor and resource stop gates match the operations budget', () => {
  assert.match(gate, /plane-preflight/);
  assert.match(gate, /minimum_mem_kib=3670016/);
  assert.match(gate, /minimum_disk_kib=36700160/);
  assert.match(gate, /memory_max.*402653184/);
  assert.match(gate, /cpu_period \* 25/);
  assert.match(docs, /p5 `MemAvailable >= 3[.]5 GiB`/);
  assert.match(docs, /p95 CPU busy.*2/);
  assert.match(docs, /`MemAvailable < 2 GiB`.*5 分钟/);
  assert.match(docs, /任何一次 `< 1[.]5 GiB`/);
  assert.match(docs, /根盘可用 `< 30 GiB`/);
  assert.match(docs, /2[.]9 GiB 低于入场线/);
});

test('Actions gives PR checks no CD secret path and main is the only image publisher', () => {
  const publish = checks.split(/^  publish:$/m)[1] ?? '';
  assert.match(checks, /^permissions:\s+contents: read/m);
  assert.match(publish, /packages: write/);
  assert.doesNotMatch(checks, /DEPLOY_SSH|DEPLOY_HOST|GHCR_READ_TOKEN/);
  assert.match(docs, /plane-github-scm-read/);
  assert.match(docs, /plane-github-actions-read/);
  assert.match(docs, /plane-ghcr-pull/);
  assert.match(docs, /plane-github-webhook-secret/);
});
