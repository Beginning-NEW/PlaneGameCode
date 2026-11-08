import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DeploymentCoordinator } from '../ops/jenkins/deployment-state.mjs';
import { SecureLedger } from '../ops/jenkins/lib/secure-ledger.mjs';

const NOW = Date.parse('2026-11-09T00:00:00Z');
const candidate = { sha: '8'.repeat(40), runId: '42', runAttempt: '1' };
const triggerId = `${candidate.sha}:42:1`;
const digest = `sha256:${'9'.repeat(64)}`;
const previous = {
  candidate: { sha: '7'.repeat(40), runId: '41', runAttempt: '1', triggerId: `${'7'.repeat(40)}:41:1` },
  digest: `sha256:${'6'.repeat(64)}`,
  runtimeIdentity: `plane-game-${'7'.repeat(40)}`,
};

async function fixture(t, inspector) {
  const parent = await mkdtemp(join(tmpdir(), 'plane-deploy-state-'));
  const root = join(parent, 'state');
  SecureLedger.initialize(root);
  const ledger = new SecureLedger(root, { now: () => NOW });
  ledger.recordRequest();
  ledger.admitCandidate(triggerId, 58);
  ledger.transitionPoller(triggerId, 'observed', { candidate: { ...candidate, triggerId } });
  ledger.transitionPoller(triggerId, 'eligible');
  ledger.transitionPoller(triggerId, 'post_intent');
  ledger.transitionPoller(triggerId, 'queued');
  ledger.transitionPoller(triggerId, 'building');
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { ledger, coordinator: new DeploymentCoordinator({ ledger, inspector }) };
}

function inspector({ observation = { kind: 'none' }, previousExact = true, prior = previous } = {}) {
  return {
    previousGood: () => prior,
    observeCandidate: async () => observation,
    previousIsExact: async () => previousExact,
  };
}

test('deploy intent is durable before side effects and exact healthy recovery never redeploys', async (t) => {
  const fake = inspector({ observation: { kind: 'healthy', containerId: 'abc' } });
  const { ledger, coordinator } = await fixture(t, fake);
  assert.deepEqual(await coordinator.begin(candidate, digest), { action: 'deploy', triggerId });
  assert.equal(ledger.getState().deployments[triggerId].state, 'deploy_intent');
  assert.equal(ledger.getState().poller[triggerId].state, 'deploy_claimed');
  assert.deepEqual(await coordinator.reconcile(triggerId), { action: 'recovered_success' });
  assert.equal(ledger.getState().deployments[triggerId].state, 'deploy_succeeded');
  assert.equal(ledger.getState().poller[triggerId].state, 'succeeded');
});

test('crash after deploy_observed completes the intent before no-side-effect disposition', async (t) => {
  const { ledger, coordinator } = await fixture(t, inspector());
  ledger.recordDeployment(triggerId, 'deploy_observed', {
    candidate: { ...candidate, triggerId }, digest, previousGood: previous,
    runtimeIdentity: `plane-game-${candidate.sha}`,
  });
  assert.deepEqual(await coordinator.begin(candidate, digest), { action: 'no_side_effect_failure' });
  assert.equal(ledger.getState().deployments[triggerId].state, 'failed');
  assert.equal(ledger.getState().poller[triggerId].state, 'failed');
});

test('crash between deployment intent and poller claim recovers one exact healthy runtime', async (t) => {
  const { ledger, coordinator } = await fixture(t, inspector({ observation: { kind: 'healthy' } }));
  ledger.recordDeployment(triggerId, 'deploy_observed', {
    candidate: { ...candidate, triggerId }, digest, previousGood: previous,
    runtimeIdentity: `plane-game-${candidate.sha}`,
  });
  ledger.recordDeployment(triggerId, 'deploy_intent');
  assert.deepEqual(await coordinator.begin(candidate, digest), { action: 'recovered_success' });
  assert.equal(ledger.getState().deployments[triggerId].state, 'deploy_succeeded');
  assert.equal(ledger.getState().poller[triggerId].state, 'succeeded');
});

test('crash after deployment success repairs poller only after exact runtime proof', async (t) => {
  const { ledger, coordinator } = await fixture(t, inspector({ observation: { kind: 'healthy' } }));
  await coordinator.begin(candidate, digest);
  ledger.recordDeployment(triggerId, 'runtime_present');
  ledger.recordDeployment(triggerId, 'health_verified');
  ledger.recordDeployment(triggerId, 'deploy_succeeded');
  assert.equal(ledger.getState().poller[triggerId].state, 'deploy_claimed');
  await assert.rejects(coordinator.begin(candidate, `sha256:${'a'.repeat(64)}`), {
    code: 'deployment_digest_conflict',
  });
  assert.deepEqual(await coordinator.begin(candidate, digest), { action: 'recovered_success' });
  assert.equal(ledger.getState().poller[triggerId].state, 'succeeded');
});

test('crash after rollback verification records failure without repeating rollback', async (t) => {
  const { ledger, coordinator } = await fixture(t, inspector());
  await coordinator.begin(candidate, digest);
  ledger.recordDeployment(triggerId, 'rollback_intent');
  ledger.recordDeployment(triggerId, 'rollback_verified');
  assert.deepEqual(await coordinator.reconcile(triggerId), { action: 'terminal', state: 'failed' });
  assert.equal(ledger.getState().deployments[triggerId].state, 'failed');
  assert.equal(ledger.getState().poller[triggerId].state, 'failed');
});

test('deploy_succeeded repair quarantines unless the exact candidate runtime is still healthy', async (t) => {
  const { ledger, coordinator } = await fixture(t, inspector({ observation: { kind: 'mismatch' } }));
  await coordinator.begin(candidate, digest);
  ledger.recordDeployment(triggerId, 'runtime_present');
  ledger.recordDeployment(triggerId, 'health_verified');
  ledger.recordDeployment(triggerId, 'deploy_succeeded');
  assert.deepEqual(await coordinator.reconcile(triggerId), {
    action: 'quarantined',
    reason: 'terminal_runtime_unverifiable',
  });
  assert.equal(ledger.getState().deployments[triggerId].state, 'deploy_succeeded');
  assert.equal(ledger.getState().poller[triggerId].state, 'quarantined');
});

test('rollback_verified repair quarantines without a second rollback when previous-good proof is lost', async (t) => {
  const { ledger, coordinator } = await fixture(t, inspector({ previousExact: false }));
  await coordinator.begin(candidate, digest);
  ledger.recordDeployment(triggerId, 'rollback_intent');
  ledger.recordDeployment(triggerId, 'rollback_verified');
  assert.deepEqual(await coordinator.reconcile(triggerId), {
    action: 'quarantined',
    reason: 'rollback_unverifiable',
  });
  assert.equal(ledger.getState().deployments[triggerId].state, 'quarantined');
  assert.equal(ledger.getState().poller[triggerId].state, 'quarantined');
});

test('failed cross-ledger repair re-observes previous-good before changing the poller ledger', async (t) => {
  const { ledger, coordinator } = await fixture(t, inspector({ previousExact: false }));
  await coordinator.begin(candidate, digest);
  ledger.recordDeployment(triggerId, 'failed', { failure: 'no_side_effect' });
  assert.deepEqual(await coordinator.reconcile(triggerId), {
    action: 'quarantined',
    reason: 'previous_good_unverifiable',
  });
  assert.equal(ledger.getState().deployments[triggerId].state, 'failed');
  assert.equal(ledger.getState().poller[triggerId].state, 'quarantined');
});
test('zero candidate plus exact previous good records no-side-effect terminal failure', async (t) => {
  const { ledger, coordinator } = await fixture(t, inspector());
  await coordinator.begin(candidate, digest);
  assert.deepEqual(await coordinator.reconcile(triggerId), { action: 'no_side_effect_failure' });
  assert.equal(ledger.getState().deployments[triggerId].state, 'failed');
  assert.equal(ledger.getState().poller[triggerId].state, 'failed');
});

test('mismatched candidate durably claims exactly one rollback and verifies previous good', async (t) => {
  const { ledger, coordinator } = await fixture(t, inspector({ observation: { kind: 'mismatch' } }));
  await coordinator.begin(candidate, digest);
  assert.deepEqual(await coordinator.reconcile(triggerId), { action: 'rollback_once', previousSha: previous.candidate.sha });
  assert.equal(ledger.getState().deployments[triggerId].state, 'rollback_intent');
  assert.throws(() => coordinator.markRollbackIntent(triggerId, 'again'), { code: 'rollback_already_claimed' });
  assert.deepEqual(await coordinator.completeRollback(triggerId), { action: 'rollback_verified' });
  assert.equal(ledger.getState().deployments[triggerId].state, 'failed');
});

for (const observation of [{ kind: 'multiple' }, { kind: 'unverifiable' }]) {
  test(`${observation.kind} runtime evidence quarantines without deployment or rollback`, async (t) => {
    const { ledger, coordinator } = await fixture(t, inspector({ observation }));
    await coordinator.begin(candidate, digest);
    const result = await coordinator.reconcile(triggerId);
    assert.equal(result.action, 'quarantined');
    assert.equal(ledger.getState().deployments[triggerId].state, 'quarantined');
    assert.equal(ledger.getState().poller[triggerId].state, 'quarantined');
  });
}

test('rollback crash recovery never repeats rollback and quarantines unverifiable previous good', async (t) => {
  const { ledger, coordinator } = await fixture(t, inspector({
    observation: { kind: 'mismatch' },
    previousExact: false,
  }));
  await coordinator.begin(candidate, digest);
  await coordinator.reconcile(triggerId);
  const result = await coordinator.reconcile(triggerId);
  assert.equal(result.action, 'quarantined');
  assert.equal(ledger.getState().deployments[triggerId].state, 'quarantined');
});
