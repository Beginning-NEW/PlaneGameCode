import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
      return overrides.enqueue ? overrides.enqueue(candidate, calls.enqueue) : {
        queueId: '1',
        queueUrl: 'http://jenkins.test/queue/item/1/',
      };
    },
    async reconcile(record) {
      calls.reconcile += 1;
      return overrides.reconcile ? overrides.reconcile(record) : null;
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
    return { queueId: '7', queueUrl: 'http://jenkins.test/queue/item/7/' };
  } });
  const { admission, store } = await fixture(t, { enqueuer });
  const first = admission.handle(request());
  const duplicate = await admission.handle(request());
  release();
  assert.equal((await first).body.code, 'queued');
  assert.equal(duplicate.body.code, 'submitted_unknown');
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
  assert.equal((await restarted.handle(request())).body.code, 'queue_state_unknown');
  assert.equal(enqueuer.calls.enqueue, 1);
  assert.equal(enqueuer.calls.reconcile, 1);
  restartedStore.close();
});

test('a restart after durable submission reconciles an existing Jenkins queue item without retrying', async (t) => {
  const { directory, store } = await fixture(t);
  store.reserve(delivery, {
    candidateSha: trusted.workflow_run.head_sha,
    runId: String(trusted.workflow_run.id),
    runAttempt: String(trusted.workflow_run.run_attempt),
  });
  store.markSubmitted(delivery);
  store.close();
  const restartedStore = new DeliveryStore(join(directory, 'deliveries.sqlite'));
  const enqueuer = fakeEnqueuer({ reconcile: () => ({
    state: 'queued',
    queueId: '9',
    queueUrl: 'http://jenkins.test/queue/item/9/',
  }) });
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

test('an ambiguous enqueue failure is quarantined and never automatically posted again', async (t) => {
  const enqueuer = fakeEnqueuer({ enqueue: () => {
    throw Object.assign(new Error('connection reset'), { code: 'jenkins_unavailable' });
  } });
  const { admission, store } = await fixture(t, { enqueuer });
  assert.equal((await admission.handle(request())).body.code, 'enqueue_outcome_unknown');
  assert.equal(store.get(delivery).state, 'submitted');
  assert.equal((await admission.handle(request())).body.code, 'submitted_unknown');
  assert.deepEqual(enqueuer.calls, { enqueue: 1, reconcile: 1 });
  assert.equal(store.get(delivery).retry_count, 0);
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

test('a pre-POST submitted-state write failure remains safely retryable with zero queue side effects', async (t) => {
  const enqueuer = fakeEnqueuer();
  const base = await fixture(t, { enqueuer });
  const original = base.store.markSubmitted.bind(base.store);
  let failOnce = true;
  base.store.markSubmitted = (...args) => {
    if (failOnce) {
      failOnce = false;
      throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
    }
    return original(...args);
  };
  assert.equal((await base.admission.handle(request())).body.code, 'state_write_failed');
  assert.equal(base.store.get(delivery).state, 'failed');
  assert.deepEqual(enqueuer.calls, { enqueue: 0, reconcile: 0 });
  assert.equal((await base.admission.handle(request())).body.code, 'queued');
  assert.deepEqual(enqueuer.calls, { enqueue: 1, reconcile: 0 });
});

test('a queued-state persistence failure never reports success and can be reconciled on retry', async (t) => {
  const enqueuer = fakeEnqueuer({ reconcile: () => ({
    state: 'queued',
    queueId: '13',
    queueUrl: 'http://jenkins.test/queue/item/13/',
  }) });
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
  assert.equal(base.store.get(delivery).state, 'submitted');
  assert.equal((await base.admission.handle(request())).body.code, 'already_queued');
  assert.deepEqual(enqueuer.calls, { enqueue: 1, reconcile: 1 });
});

test('a confirmed enqueue with a queued-state write failure never posts a second build in the visibility gap', async (t) => {
  const enqueuer = fakeEnqueuer({ reconcile: () => null });
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
  assert.equal(base.store.get(delivery).state, 'submitted');
  assert.equal((await base.admission.handle(request())).body.code, 'submitted_unknown');
  assert.deepEqual(enqueuer.calls, { enqueue: 1, reconcile: 1 });
});

test('legacy ambiguous rows migrate to non-retryable submitted state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'plane-webhook-legacy-'));
  const path = join(directory, 'deliveries.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE webhook_deliveries (
      delivery_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, run_attempt TEXT NOT NULL,
      candidate_sha TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('dispatching', 'queued', 'failed')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      retryable INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0, 1)),
      queue_url TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (run_id, run_attempt)
    ) STRICT;
  `);
  legacy.prepare(`
    INSERT INTO webhook_deliveries (
      delivery_id, run_id, run_attempt, candidate_sha, state, retryable, created_at, updated_at
    ) VALUES (?, '123456789', '1', ?, 'failed', 1, ?, ?)
  `).run(delivery, trusted.workflow_run.head_sha, '2026-11-06T00:00:00.000Z', '2026-11-06T00:00:01.000Z');
  legacy.close();

  const migrated = new DeliveryStore(path);
  assert.equal(migrated.get(delivery).state, 'submitted');
  assert.equal(migrated.get(delivery).retryable, 0);
  assert.equal(migrated.get(delivery).error_code, 'legacy_outcome_unknown');
  migrated.close();
});

test('reconciliation persists monotonic queued, running, and completed build identity', async (t) => {
  const { admission, store } = await fixture(t);
  assert.equal((await admission.handle(request())).body.code, 'queued');
  store.recordReconciliation(delivery, {
    state: 'running',
    buildNumber: '17',
    buildUrl: 'http://jenkins.test/job/plane-game/job/main-cd/17/',
  });
  store.recordReconciliation(delivery, { state: 'completed', buildResult: 'SUCCESS' });
  store.recordReconciliation(delivery, { state: 'queued' });
  assert.deepEqual(
    (({ state, queue_id, build_number, build_result }) => ({
      state, queue_id, build_number, build_result,
    }))(store.get(delivery)),
    { state: 'completed', queue_id: '1', build_number: '17', build_result: 'SUCCESS' },
  );
});
