import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const [jobDsl, docs, verify, pipeline, admission, gateway, service] = await Promise.all([
  readFile(new URL('../ops/jenkins/config/plane-game-job.groovy', import.meta.url), 'utf8'),
  readFile(new URL('../RUNBOOK.md', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/verify-candidate.sh', import.meta.url), 'utf8'),
  readFile(new URL('../Jenkinsfile', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/webhook-admission.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/webhook-gateway.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/config/plane-game-webhook-gateway.service', import.meta.url), 'utf8'),
]);

test('webhook admission validates HMAC and persists atomic delivery and run uniqueness before enqueue', () => {
  for (const value of [
    'workflow_run',
    'completed',
    'Beginning-NEW/PlaneGameCode',
    'Checks',
    '.github/workflows/checks.yml',
    'verifySignature(rawBody, signature, secret)',
    'BEGIN IMMEDIATE',
    'PRIMARY KEY',
    'UNIQUE (run_id, run_attempt)',
    "state IN ('dispatching', 'submitted', 'queued', 'running', 'completed', 'failed')".replace(/ /g, ''),
    'markSubmitted(deliveryId)',
    'recordReconciliation(deliveryId, observation, { incrementAttempt = true } = {})',
    'reconcile_count',
    'recordReconciliationError(deliveryId, errorCode)',
  ]) assert.ok(admission.replace(/\s/g, '').includes(value.replace(/\s/g, '')), `missing admission control: ${value}`);
  for (const value of [
    'x-hub-signature-256',
    'x-github-delivery',
    '/github/workflow-run',
    'WEBHOOK_DELIVERY',
    '/buildWithParameters',
    'reconcile(record)',
    'normalizeQueueIdentity(location)',
    'hasCandidateIdentity(actions, record)',
    'uniqueMatch(items, predicate, multipleCode)',
  ]) assert.ok(gateway.includes(value), `missing gateway control: ${value}`);
  for (const value of [
    'StateDirectory=plane-game-webhook',
    'LoadCredential=webhook-secret:',
    'LoadCredential=jenkins-api-token:',
    '/usr/bin/flock --no-fork --nonblock',
    'ProtectSystem=strict',
  ]) assert.ok(service.includes(value), `missing service control: ${value}`);
  for (const value of [
    "stringParam('WEBHOOK_DELIVERY'",
    'disabled(true)',
  ]) assert.ok(jobDsl.includes(value), `missing webhook contract value: ${value}`);
  assert.doesNotMatch(jobDsl, /genericTrigger|triggers\s*\{/);
  assert.ok(pipeline.includes('params.WEBHOOK_DELIVERY ==~ /(?i)[0-9a-f]{8}'));
});

test('offline webhook dry-run queues once and rejects without logging secrets', () => {
  const script = fileURLToPath(new URL('../ops/jenkins/webhook-contract-dry-run.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /queued=1 duplicate=1 rejected=2 hmac=verified payload_logged=0 secret_logged=0/);
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
    'delivery_id',
    'run_id, run_attempt',
    'reservation',
    'queued',
    'failed',
  ]) assert.ok(docs.includes(value), `missing RUNBOOK boundary: ${value}`);
  assert.match(docs, /单调递增的 Actions `run_number`/);
  assert.match(docs, /`run_id` 只用于唯一标识 run/);
  assert.match(docs, /专用机器账号用户名 \+ 可轮换 PAT \(classic\)/);
  assert.doesNotMatch(docs, /Actions run id 单调|较旧 Actions run id|专用机器人用户名 \+ 可轮换 token/);
});
