import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DeliveryStore, WebhookAdmission } from '../ops/jenkins/webhook-admission.mjs';

const delivery = '123e4567-e89b-42d3-a456-426614174000';
const secondDelivery = '223e4567-e89b-42d3-a456-426614174000';
const secret = Buffer.from('test-only-webhook-secret');
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
    head_sha: '0123456789abcdef0123456789abcdef01234567',
    id: 123456789,
    run_attempt: 1,
    head_repository: { full_name: 'Beginning-NEW/PlaneGameCode' },
  },
};

function request(overrides = {}) {
  const rawBody = overrides.rawBody ?? Buffer.from(JSON.stringify(overrides.payload ?? trusted));
  return {
    rawBody,
    signature: overrides.signature ?? `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
    deliveryId: Object.hasOwn(overrides, 'deliveryId') ? overrides.deliveryId : delivery,
    event: overrides.event ?? 'workflow_run',
  };
}

function fakeEnqueuer(overrides = {}) {
  const calls = { enqueue: 0, reconcile: 0 };
  return {
    calls,
    async enqueue(candidate) {
      calls.enqueue += 1;
      return overrides.enqueue ? overrides.enqueue(candidate, calls.enqueue) : { queueUrl: '/queue/item/1/' };
    },
    async reconcile(deliveryId) {
      calls.reconcile += 1;
      return overrides.reconcile ? overrides.reconcile(deliveryId) : null;
    },
  };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'plane-webhook-'));
  const store = options.store ?? new DeliveryStore(join(directory, 'deliveries.sqlite'));
  const enqueuer = options.enqueuer ?? fakeEnqueuer();
  const logs = [];
  const admission = new WebhookAdmission({
    webhookSecretProvider: options.webhookSecretProvider ?? { get: () => secret },
    store,
    enqueuer,
    logger: (entry) => logs.push(entry),
  });
  t.after(async () => {
    store.close?.();
    await rm(directory, { recursive: true, force: true });
  });
  return { admission, directory, store, enqueuer, logs };
}

test('HMAC is verified before delivery validation and every rejection has zero queue side effects', async (t) => {
  const { admission, enqueuer, logs } = await fixture(t);
  const cases = [
    request({ signature: 'sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    request({ deliveryId: undefined }),
    request({ deliveryId: '' }),
    request({ deliveryId: 'not-a-uuid' }),
    request({ event: 'push' }),
    request({ payload: { ...trusted, action: 'requested' } }),
  ];
  for (const candidate of cases) assert.notEqual((await admission.handle(candidate)).body.code, 'queued');
  const wrongSignatureAndDelivery = await admission.handle(request({ signature: 'bad', deliveryId: '' }));
  assert.equal(wrongSignatureAndDelivery.body.code, 'invalid_signature');
  assert.deepEqual(enqueuer.calls, { enqueue: 0, reconcile: 0 });
  assert.equal(JSON.stringify(logs).includes(secret.toString()), false);
  assert.equal(JSON.stringify(logs).includes(JSON.stringify(trusted)), false);
});

test('a trusted main success delivery is atomically queued once under concurrency', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const enqueuer = fakeEnqueuer({ enqueue: async () => {
    await gate;
    return { queueUrl: '/queue/item/7/' };
  } });
  const { admission, store } = await fixture(t, { enqueuer });
  const first = admission.handle(request());
  const duplicate = await admission.handle(request());
  release();
  assert.equal((await first).body.code, 'queued');
  assert.equal(duplicate.body.code, 'dispatch_in_progress');
  assert.equal(enqueuer.calls.enqueue, 1);
  assert.equal(store.get(delivery).state, 'queued');
});

test('queued delivery remains deduplicated after process restart', async (t) => {
  const { admission, directory, store, enqueuer } = await fixture(t);
  assert.equal((await admission.handle(request())).body.code, 'queued');
  store.close();
  const restartedStore = new DeliveryStore(join(directory, 'deliveries.sqlite'));
  const restarted = new WebhookAdmission({
    webhookSecretProvider: { get: () => secret },
    store: restartedStore,
    enqueuer,
  });
  assert.equal((await restarted.handle(request())).body.code, 'already_queued');
  assert.equal(enqueuer.calls.enqueue, 1);
  restartedStore.close();
});

test('a restart during dispatch reconciles an existing Jenkins queue item before retrying', async (t) => {
  const { directory, store } = await fixture(t);
  store.reserve(delivery, {
    candidateSha: trusted.workflow_run.head_sha,
    runId: String(trusted.workflow_run.id),
    runAttempt: String(trusted.workflow_run.run_attempt),
  });
  store.close();
  const restartedStore = new DeliveryStore(join(directory, 'deliveries.sqlite'));
  const enqueuer = fakeEnqueuer({ reconcile: () => ({ queueUrl: '/queue/item/9/' }) });
  const admission = new WebhookAdmission({
    webhookSecretProvider: { get: () => secret },
    store: restartedStore,
    enqueuer,
  });
  assert.equal((await admission.handle(request())).body.code, 'already_queued');
  assert.deepEqual(enqueuer.calls, { enqueue: 0, reconcile: 1 });
  assert.equal(restartedStore.get(delivery).state, 'queued');
  restartedStore.close();
});

test('definite enqueue failure is durable and a later delivery retry is safe', async (t) => {
  const enqueuer = fakeEnqueuer({ enqueue: (_candidate, call) => {
    if (call === 1) throw Object.assign(new Error('offline'), { code: 'jenkins_unavailable' });
    return { queueUrl: '/queue/item/11/' };
  } });
  const { admission, store } = await fixture(t, { enqueuer });
  assert.equal((await admission.handle(request())).body.code, 'enqueue_failed');
  assert.equal(store.get(delivery).state, 'failed');
  assert.equal((await admission.handle(request())).body.code, 'queued');
  assert.deepEqual(enqueuer.calls, { enqueue: 2, reconcile: 1 });
  assert.equal(store.get(delivery).retry_count, 1);
});

test('the same workflow run identity cannot be replayed with a different delivery', async (t) => {
  const { admission, enqueuer } = await fixture(t);
  assert.equal((await admission.handle(request())).body.code, 'queued');
  assert.equal((await admission.handle(request({ deliveryId: secondDelivery }))).body.code, 'run_already_reserved');
  assert.equal(enqueuer.calls.enqueue, 1);
});

test('reservation persistence failure returns retryable failure before Jenkins credentials or queue', async (t) => {
  const enqueuer = fakeEnqueuer();
  const store = {
    reserve() { throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' }); },
    close() {},
  };
  const { admission } = await fixture(t, { store, enqueuer });
  assert.equal((await admission.handle(request())).body.code, 'reservation_failed');
  assert.deepEqual(enqueuer.calls, { enqueue: 0, reconcile: 0 });
});

test('a queued-state persistence failure never reports success and can be reconciled on retry', async (t) => {
  const enqueuer = fakeEnqueuer({ reconcile: () => ({ queueUrl: '/queue/item/13/' }) });
  const base = await fixture(t, { enqueuer });
  const original = base.store.markQueued.bind(base.store);
  let failOnce = true;
  base.store.markQueued = (...args) => {
    if (failOnce) {
      failOnce = false;
      throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
    }
    return original(...args);
  };
  assert.equal((await base.admission.handle(request())).body.code, 'state_write_failed');
  assert.equal(base.store.get(delivery).state, 'failed');
  assert.equal((await base.admission.handle(request())).body.code, 'already_queued');
  assert.deepEqual(enqueuer.calls, { enqueue: 1, reconcile: 1 });
});
