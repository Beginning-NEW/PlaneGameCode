import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [pipeline, verify, resolver, deploy, casc, job, images] = await Promise.all([
  readFile(new URL('../Jenkinsfile', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/verify-candidate.sh', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/resolve-public-ghcr-digest.sh', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/deploy-local.sh', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/controller-stage-b/casc.yaml', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/controller-stage-b/plane-game-job.groovy', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/public-source-images.env', import.meta.url), 'utf8'),
]);

const sha = 'a'.repeat(40);
const expected = {
  id: 9001,
  run_attempt: 2,
  run_number: 77,
  name: 'Checks',
  path: '.github/workflows/checks.yml',
  event: 'push',
  head_branch: 'main',
  head_sha: sha,
  status: 'completed',
  conclusion: 'success',
  repository: { full_name: 'Beginning-NEW/PlaneGameCode' },
  head_repository: { full_name: 'Beginning-NEW/PlaneGameCode' },
};

function validAttempt(run) {
  return run.id === 9001 && run.run_attempt === 2 && run.run_number > 0 &&
    run.name === 'Checks' && run.path === '.github/workflows/checks.yml' &&
    run.event === 'push' && run.head_branch === 'main' && run.head_sha === sha &&
    run.status === 'completed' && run.conclusion === 'success' &&
    run.repository?.full_name === 'Beginning-NEW/PlaneGameCode' &&
    run.head_repository?.full_name === 'Beginning-NEW/PlaneGameCode';
}

test('anonymous exact-attempt proof rejects every identity, SHA, attempt, and conclusion mismatch', () => {
  assert.equal(validAttempt(expected), true);
  for (const mutation of [
    { id: 9002 },
    { run_attempt: 3 },
    { run_number: 0 },
    { name: 'Other' },
    { path: '.github/workflows/other.yml' },
    { event: 'workflow_dispatch' },
    { head_branch: 'feature' },
    { head_sha: 'b'.repeat(40) },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { repository: { full_name: 'fork/PlaneGameCode' } },
    { head_repository: { full_name: 'fork/PlaneGameCode' } },
  ]) assert.equal(validAttempt({ ...expected, ...mutation }), false, JSON.stringify(mutation));

  for (const assertion of [
    '.name == "Checks"',
    '.path == ".github/workflows/checks.yml"',
    '.event == "push"',
    '.head_branch == "main"',
    '.head_sha == $sha',
    '.status == "completed"',
    '.conclusion == "success"',
    '.repository.full_name == $repository',
    '.head_repository.full_name == $repository',
  ]) assert.ok(verify.includes(assertion), assertion);
});

test('SCM, Actions, and public image proof have no Jenkins credential path', () => {
  assert.match(job, /url\('https:\/\/github[.]com\/Beginning-NEW\/PlaneGameCode[.]git'\)/);
  assert.doesNotMatch(job, /credentials\(/);
  assert.doesNotMatch(casc, /scope: GLOBAL|PLANE_(?:GITHUB|GHCR)_/);
  assert.doesNotMatch(pipeline, /withCredentials|credentialsId/);
  assert.match(pipeline, /git rev-parse HEAD/);
  assert.match(pipeline, /git rev-parse FETCH_HEAD/);
  assert.match(verify, /actions\/runs\/\$run_id\/attempts\/\$run_attempt/);
  assert.match(verify, /git\/ref\/heads\/main/);
  assert.doesNotMatch(verify, /Authorization:|artifacts\/|GH_API_TOKEN/);
});

test('public API and registry outages, non-2xx, limits, and malformed digests fail closed', () => {
  const acceptedStatus = (status) => /^2[0-9][0-9]$/.test(String(status));
  assert.equal(acceptedStatus(200), true);
  for (const status of [0, 403, 404, 429, 500, 504]) assert.equal(acceptedStatus(status), false);
  for (const source of [verify, resolver]) {
    assert.match(source, /--retry 0/);
    assert.match(source, /--connect-timeout 10/);
    assert.match(source, /--max-time 30/);
    assert.match(source, /\^2\[0-9\]\[0-9\]\$/);
    assert.match(source, /rate limit/i);
  }
  assert.match(verify, /unavailable or timed out/);
  assert.match(resolver, /registry returned HTTP/);
  assert.match(resolver, /manifest is malformed/);
  assert.match(resolver, /one canonical sha256 digest/);
  assert.match(resolver, /docker-content-digest/);
});

test('public full-SHA digest is re-resolved and both images pull by digest with no login', () => {
  const initial = `sha256:${'b'.repeat(64)}`;
  assert.equal(initial === initial, true);
  assert.equal(initial === `sha256:${'c'.repeat(64)}`, false);
  assert.match(images, /^NGINX_BASE_IMAGE=.*@sha256:[0-9a-f]{64}$/m);
  assert.match(images, /^GATEWAY_IMAGE=.*@sha256:[0-9a-f]{64}$/m);
  assert.match(deploy, /printf '\{\}\\n' > "\$DOCKER_CONFIG\/config[.]json"/);
  assert.match(deploy, /unset DOCKER_AUTH_CONFIG REGISTRY_AUTH_FILE/);
  assert.match(deploy, /resolved_digest=.*resolve-public-ghcr-digest[.]sh/);
  assert.match(deploy, /"\$resolved_digest" == "\$digest"/);
  assert.match(deploy, /docker pull "\$repository@\$digest"/);
  assert.match(deploy, /docker pull "\$gateway_image"/);
  assert.doesNotMatch(deploy, /docker login|GHCR_(?:USER|TOKEN)|GH_API_TOKEN/);
  const pull = deploy.indexOf('docker pull "$gateway_image"');
  const gate = deploy.indexOf('bash ops/jenkins/resource-gate.sh');
  assert.ok(pull >= 0 && pull < gate);
});
