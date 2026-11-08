import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  admitJenkinsBuild,
  recordRevalidationFailure,
  revalidateJenkinsCandidate,
  shouldQuarantineRevalidationFailure,
} from '../ops/jenkins/jenkins-revalidate.mjs';
import { SecureLedger } from '../ops/jenkins/lib/secure-ledger.mjs';

const NOW = Date.parse('2026-11-09T00:00:00Z');
const SHA = '8'.repeat(40);
const candidate = {
  sha: SHA,
  runId: '42498440964',
  runAttempt: '1',
  triggerId: `${SHA}:42498440964:1`,
};
const jobUrl = 'http://127.0.0.1:18080/job/plane-game/job/main-cd/';
const buildEnvironment = { BUILD_NUMBER: '41', JOB_URL: jobUrl };

async function queuedFixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'plane-jenkins-revalidate-'));
  const root = join(parent, 'state');
  SecureLedger.initialize(root);
  const ledger = new SecureLedger(root, { now: () => NOW });
  ledger.admitCandidate(candidate.triggerId, 58);
  ledger.transitionPoller(candidate.triggerId, 'observed', { candidate });
  ledger.transitionPoller(candidate.triggerId, 'eligible');
  ledger.transitionPoller(candidate.triggerId, 'post_intent');
  ledger.transitionPoller(candidate.triggerId, 'queued', {
    queueId: '17',
    queueUrl: 'http://127.0.0.1:18080/queue/item/17/',
  });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return ledger;
}

test('queued build records exact Jenkins identity before validation and the same in-flight build resumes', async (t) => {
  const ledger = await queuedFixture(t);
  const validations = [];
  const validate = async (client, seenCandidate) => {
    validations.push({ client, seenCandidate });
    return { pass: true };
  };
  const client = { kind: 'github-client' };

  assert.deepEqual(await revalidateJenkinsCandidate({
    ledger, candidate, client, environment: buildEnvironment, validate,
  }), { pass: true });
  assert.deepEqual(ledger.getState().poller[candidate.triggerId], {
    candidate,
    queueId: '17',
    queueUrl: 'http://127.0.0.1:18080/queue/item/17/',
    state: 'building',
    buildNumber: '41',
    buildUrl: `${jobUrl}41/`,
    updatedAtMs: NOW,
  });

  assert.deepEqual(await revalidateJenkinsCandidate({
    ledger, candidate, client, environment: buildEnvironment, validate,
  }), { pass: true });
  assert.equal(validations.length, 2);
  assert.ok(validations.every((entry) => entry.client === client && entry.seenCandidate === candidate));
});

test('a different or malformed build cannot consume an in-flight tuple', async (t) => {
  const ledger = await queuedFixture(t);
  await revalidateJenkinsCandidate({
    ledger,
    candidate,
    client: {},
    environment: buildEnvironment,
    validate: async () => ({ pass: true }),
  });
  let validations = 0;
  for (const environment of [
    { ...buildEnvironment, BUILD_NUMBER: '42' },
    { ...buildEnvironment, JOB_URL: 'http://127.0.0.1:18080/job/other/' },
  ]) {
    await assert.rejects(revalidateJenkinsCandidate({
      ledger,
      candidate,
      client: {},
      environment,
      validate: async () => { validations += 1; },
    }), { code: environment.BUILD_NUMBER === '42'
      ? 'jenkins_build_identity_mismatch' : 'jenkins_build_identity_invalid' });
  }
  assert.equal(validations, 0);
  assert.equal(ledger.getState().poller[candidate.triggerId].state, 'building');
  assert.equal(shouldQuarantineRevalidationFailure('jenkins_build_identity_mismatch', 'building'), false);
  assert.equal(shouldQuarantineRevalidationFailure('jenkins_build_identity_invalid', 'building'), false);
  assert.equal(shouldQuarantineRevalidationFailure('jenkins_build_identity_invalid', 'queued'), true);
  const remaining = ledger.getState().budget.reservations[candidate.triggerId].remaining;
  assert.deepEqual(recordRevalidationFailure(ledger, candidate.triggerId,
    Object.assign(new Error('duplicate'), { code: 'jenkins_build_identity_mismatch' })),
  { quarantined: false });
  assert.deepEqual(recordRevalidationFailure(ledger, candidate.triggerId,
    Object.assign(new Error('malformed duplicate'), { code: 'jenkins_build_identity_invalid' })),
  { quarantined: false });
  assert.equal(ledger.getState().poller[candidate.triggerId].state, 'building');
  assert.equal(ledger.getState().budget.reservations[candidate.triggerId].remaining, remaining);

  assert.deepEqual(recordRevalidationFailure(ledger, candidate.triggerId,
    Object.assign(new Error('validation failed'), { code: 'github_http_rejected' })),
  { quarantined: true });
  assert.equal(ledger.getState().poller[candidate.triggerId].state, 'quarantined');
  assert.equal(ledger.getState().budget.reservations[candidate.triggerId].remaining, 0);
});

test('sequential builds reject after deployment claim and queued builds require fixed Jenkins identity', async (t) => {
  const ledger = await queuedFixture(t);
  assert.throws(() => admitJenkinsBuild(ledger.getState().poller[candidate.triggerId], {
    BUILD_NUMBER: '0', JOB_URL: jobUrl,
  }), { code: 'jenkins_build_identity_invalid' });
  ledger.transitionPoller(candidate.triggerId, 'building', {
    buildNumber: '41', buildUrl: `${jobUrl}41/`,
  });
  ledger.transitionPoller(candidate.triggerId, 'deploy_claimed');
  let validations = 0;
  await assert.rejects(revalidateJenkinsCandidate({
    ledger,
    candidate,
    client: {},
    environment: buildEnvironment,
    validate: async () => { validations += 1; },
  }), { code: 'tuple_not_queued' });
  assert.equal(validations, 0);
  assert.equal(ledger.getState().poller[candidate.triggerId].state, 'deploy_claimed');
  assert.equal(shouldQuarantineRevalidationFailure('tuple_not_queued'), false);
});
