import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const [jobDsl, jcasc, docs, verify, pipeline] = await Promise.all([
  readFile(new URL('../ops/jenkins/config/plane-game-job.groovy', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/config/generic-webhook-trigger.yaml', import.meta.url), 'utf8'),
  readFile(new URL('../RUNBOOK.md', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/verify-candidate.sh', import.meta.url), 'utf8'),
  readFile(new URL('../Jenkinsfile', import.meta.url), 'utf8'),
]);

test('webhook configuration validates HMAC and filters the exact trusted workflow_run', () => {
  for (const value of [
    'X-Hub-Signature-256',
    'plane-github-webhook-secret',
    'HmacSHA256',
  ]) assert.ok(jcasc.includes(value));
  assert.match(jcasc, /hmacEnabled:\s+true/);
  assert.doesNotMatch(jcasc, /secret(Text|Value)?:/i);

  for (const value of [
    "key('X-GitHub-Event')",
    "value('$.workflow_run.head_sha')",
    "value('$.workflow_run.id')",
    "value('$.workflow_run.run_attempt')",
    "value('$.workflow_run.head_repository.full_name')",
    "value('$.repository.full_name')",
    'workflow_run',
    'completed',
    'Beginning-NEW/PlaneGameCode',
    'Checks',
    'checks[.]yml',
    'printContributedVariables(false)',
    'printPostContent(false)',
    'disabled(true)',
  ]) assert.ok(jobDsl.includes(value), `missing webhook contract value: ${value}`);
});

test('offline webhook dry-run accepts one trusted fixture and rejects mismatches without logging secrets', () => {
  const script = fileURLToPath(new URL('../ops/jenkins/webhook-contract-dry-run.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /accepted=1 rejected=5 hmac=verified payload_logged=0 secret_logged=0/);
});

test('ordering and credential documentation preserve the reviewed safety boundary', () => {
  assert.match(verify, /api_run_number/);
  assert.match(verify, /[.]run_number \| tostring.*\$run_number/);
  assert.match(pipeline, /ACTIONS_RUN_NUMBER.*ACTIONS_RUN_ATTEMPT/s);
  for (const value of [
    'PAT (classic)',
    'read:packages',
    'write:packages',
    'delete:packages',
    'SSO authorization',
    'expiry',
    'rotation',
    'revocation',
    'GITHUB_TOKEN',
    '[YOU-47](/YOU/issues/YOU-47)',
    'cannot replace that admission gate',
  ]) assert.ok(docs.includes(value), `missing RUNBOOK boundary: ${value}`);
});
