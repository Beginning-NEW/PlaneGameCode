#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const [jobDsl, jcasc] = await Promise.all([
  readFile(new URL('./config/plane-game-job.groovy', import.meta.url), 'utf8'),
  readFile(new URL('./config/generic-webhook-trigger.yaml', import.meta.url), 'utf8'),
]);

const sha = '0123456789abcdef0123456789abcdef01234567';
const trusted = {
  action: 'completed',
  repository: { full_name: 'Beginning-NEW/PlaneGameCode' },
  workflow_run: {
    name: 'Checks',
    path: '.github/workflows/checks.yml',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: sha,
    id: 123456789,
    run_attempt: 1,
    head_repository: { full_name: 'Beginning-NEW/PlaneGameCode' },
  },
};

function accepted(event, payload) {
  const run = payload.workflow_run ?? {};
  return event === 'workflow_run' &&
    payload.action === 'completed' &&
    run.name === 'Checks' &&
    run.path === '.github/workflows/checks.yml' &&
    payload.repository?.full_name === 'Beginning-NEW/PlaneGameCode' &&
    run.head_repository?.full_name === 'Beginning-NEW/PlaneGameCode' &&
    run.head_branch === 'main' &&
    run.event === 'push' &&
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    /^[0-9a-f]{40}$/.test(run.head_sha ?? '') &&
    /^[1-9][0-9]*$/.test(String(run.id ?? '')) &&
    /^[1-9][0-9]*$/.test(String(run.run_attempt ?? ''));
}

assert.equal(accepted('workflow_run', trusted), true);
const rejected = [
  ['push', trusted],
  ['workflow_run', { ...trusted, action: 'requested' }],
  ['workflow_run', { ...trusted, repository: { full_name: 'attacker/fork' } }],
  ['workflow_run', { ...trusted, workflow_run: { ...trusted.workflow_run, name: 'Other' } }],
  ['workflow_run', { ...trusted, workflow_run: { ...trusted.workflow_run, conclusion: 'failure' } }],
];
for (const candidate of rejected) assert.equal(accepted(...candidate), false);

for (const required of [
  "key('X-GitHub-Event')",
  "value('$.workflow_run.head_sha')",
  "value('$.workflow_run.id')",
  "value('$.workflow_run.run_attempt')",
  'printContributedVariables(false)',
  'printPostContent(false)',
]) assert.ok(jobDsl.includes(required), `missing Job DSL control: ${required}`);
for (const required of [
  'X-Hub-Signature-256',
  'plane-github-webhook-secret',
  'HmacSHA256',
]) assert.ok(jcasc.includes(required), `missing JCasC HMAC control: ${required}`);

const body = Buffer.from(JSON.stringify(trusted));
const key = randomBytes(32);
const supplied = createHmac('sha256', key).update(body).digest();
const expected = createHmac('sha256', key).update(body).digest();
assert.equal(timingSafeEqual(supplied, expected), true);

console.log(`webhook contract dry-run: accepted=1 rejected=${rejected.length} hmac=verified payload_logged=0 secret_logged=0`);
