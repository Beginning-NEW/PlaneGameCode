import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { chmodSync, chownSync, linkSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { DeliveryStore, FileSecretProvider, WebhookAdmission } from '../ops/jenkins/webhook-admission.mjs';

const delivery = '123e4567-e89b-42d3-a456-426614174000';
const secondDelivery = '223e4567-e89b-42d3-a456-426614174000';
const secret = Buffer.from('test-only-webhook-secret');

test('HMAC secret consumer rejects unsafe metadata and reads atomic rotations', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'plane-hmac-secret-'));
  const path = join(directory, 'webhook-secret');
  const linked = join(directory, 'linked-secret');
  const hardlink = join(directory, 'hardlink-secret');
  const provider = new FileSecretProvider(path);
  const rejected = (candidate = path) => assert.throws(
    () => new FileSecretProvider(candidate).get(),
    (error) => error.code === 'secret_unavailable',
  );
  try {
    writeFileSync(path, secret, { mode: 0o600 });
    assert.deepEqual(provider.get(), secret);

    chmodSync(path, 0o644);
    rejected();
    chmodSync(path, 0o600);

    symlinkSync(path, linked);
    rejected(linked);

    linkSync(path, hardlink);
    rejected();
    unlinkSync(hardlink);

    writeFileSync(path, Buffer.alloc(0));
    rejected();
    writeFileSync(path, Buffer.alloc(4097, 65));
    rejected();

    writeFileSync(path, secret);
    chmodSync(directory, 0o755);
    rejected();
    chmodSync(directory, 0o700);

    if (process.getuid() === 0) {
      chownSync(path, 65534, 65534);
      rejected();
      chownSync(path, process.getuid(), process.getgid());
    }

    const rotated = Buffer.from('test-only-rotated-webhook-secret');
    writeFileSync(`${path}.next`, rotated, { mode: 0o600 });
    renameSync(`${path}.next`, path);
    assert.deepEqual(provider.get(), rotated);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
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

test('unsafe HMAC file fails admission before queue or credential use', { skip: process.platform === 'win32' }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'plane-unsafe-hmac-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'webhook-secret');
  writeFileSync(path, secret, { mode: 0o644 });
  const { admission, enqueuer, logs } = await fixture(t, {
    webhookSecretProvider: new FileSecretProvider(path),
  });
  assert.deepEqual(await admission.handle(request()), { status: 503, body: { code: 'signature_unavailable' } });
  assert.deepEqual(enqueuer.calls, { enqueue: 0, reconcile: 0 });
  assert.equal(JSON.stringify(logs).includes(secret.toString()), false);
});

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
  assert.equal(store.get(delivery).error_code, 'jenkins_unavailable');
  assert.equal(store.get(delivery).reconcile_count, 1);
  assert.ok(store.get(delivery).last_reconciled_at);
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
  assert.equal(base.store.get(delivery).error_code, 'queue_identity_persistence_failed');
  assert.equal(base.store.get(delivery).reconcile_count, 1);
  assert.equal((await base.admission.handle(request())).body.code, 'submitted_unknown');
  assert.equal(base.store.get(delivery).error_code, 'submitted_unknown');
  assert.equal(base.store.get(delivery).reconcile_count, 2);
  assert.deepEqual(enqueuer.calls, { enqueue: 1, reconcile: 1 });
});

test('a read-only primary connection after Jenkins accepts the build recovers a durable audit without reposting', async (t) => {
  const enqueuer = fakeEnqueuer({ reconcile: () => null });
  const base = await fixture(t, { enqueuer });
  const original = base.store.markQueued.bind(base.store);
  base.store.markQueued = (...args) => {
    base.store.db.exec('PRAGMA query_only = ON');
    return original(...args);
  };

  assert.equal((await base.admission.handle(request())).body.code, 'state_write_failed');
  assert.deepEqual(
    {
      state: base.store.get(delivery).state,
      errorCode: base.store.get(delivery).error_code,
      reconcileCount: base.store.get(delivery).reconcile_count,
      hasReconciledAt: Boolean(base.store.get(delivery).last_reconciled_at),
    },
    {
      state: 'submitted',
      errorCode: 'queue_identity_persistence_failed',
      reconcileCount: 1,
      hasReconciledAt: true,
    },
  );
  assert.equal((await base.admission.handle(request())).body.code, 'submitted_unknown');
  assert.equal(base.store.get(delivery).reconcile_count, 2);
  assert.deepEqual(enqueuer.calls, { enqueue: 1, reconcile: 1 });
});

test('a post-accept audit failure is explicit instead of being swallowed', async (t) => {
  const base = await fixture(t);
  base.store.markQueued = () => {
    throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
  };
  base.store.recordReconciliationError = () => {
    throw Object.assign(new Error('disk full'), { code: 'audit_persistence_failed' });
  };

  assert.equal((await base.admission.handle(request())).body.code, 'audit_persistence_failed');
  assert.deepEqual(base.logs.at(-1), { outcome: 'failed', code: 'audit_persistence_failed' });
  assert.equal(base.store.get(delivery).state, 'submitted');
  assert.equal(base.store.get(delivery).error_code, 'enqueue_outcome_pending');
  assert.deepEqual(base.enqueuer.calls, { enqueue: 1, reconcile: 0 });
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
test('empty reconciliation windows remain durably auditable across restart', async (t) => {
  const { admission, directory, store, enqueuer } = await fixture(t);
  store.reserve(delivery, {
    candidateSha: trusted.workflow_run.head_sha,
    runId: String(trusted.workflow_run.id),
    runAttempt: String(trusted.workflow_run.run_attempt),
  });
  store.markSubmitted(delivery);

  assert.equal((await admission.handle(request())).body.code, 'submitted_unknown');
  assert.equal((await admission.handle(request())).body.code, 'submitted_unknown');
  assert.equal(store.get(delivery).reconcile_count, 2);
  assert.equal(store.get(delivery).error_code, 'submitted_unknown');
  assert.ok(store.get(delivery).last_reconciled_at);
  store.close();

  const restartedStore = new DeliveryStore(join(directory, 'deliveries.sqlite'));
  const restarted = new WebhookAdmission({
    webhookSecretProvider: { get: () => secret },
    store: restartedStore,
    enqueuer,
  });
  assert.equal((await restarted.handle(request())).body.code, 'submitted_unknown');
  assert.equal(restartedStore.get(delivery).reconcile_count, 3);
  assert.equal(restartedStore.get(delivery).error_code, 'submitted_unknown');
  assert.equal(enqueuer.calls.enqueue, 0);
  restartedStore.close();
});

test('queue and build identities are write-once and mismatches are durably audited', async (t) => {
  const { admission, store } = await fixture(t);
  assert.equal((await admission.handle(request())).body.code, 'queued');

  assert.throws(
    () => store.recordReconciliation(delivery, {
      state: 'queued',
      queueId: '99',
      queueUrl: 'http://jenkins.test/queue/item/99/',
    }),
    (error) => error.code === 'observation_identity_mismatch',
  );
  let persisted = store.get(delivery);
  assert.equal(persisted.queue_id, '1');
  assert.equal(persisted.error_code, 'observation_identity_mismatch');
  assert.equal(persisted.reconcile_count, 1);

  store.recordReconciliation(delivery, {
    state: 'running',
    buildNumber: '17',
    buildUrl: 'http://jenkins.test/job/plane-game/job/main-cd/17/',
  });
  assert.throws(
    () => store.recordReconciliation(delivery, {
      state: 'running',
      buildNumber: '18',
      buildUrl: 'http://jenkins.test/job/plane-game/job/main-cd/18/',
    }),
    (error) => error.code === 'observation_identity_mismatch',
  );
  persisted = store.get(delivery);
  assert.equal(persisted.build_number, '17');
  assert.equal(persisted.error_code, 'observation_identity_mismatch');
  assert.equal(persisted.reconcile_count, 3);
});
test('reconciliation errors persist a fixed code without another enqueue', async (t) => {
  const enqueuer = fakeEnqueuer({ reconcile: () => {
    throw Object.assign(new Error('duplicate observations'), { code: 'queue_multiple_matches' });
  } });
  const { admission, store } = await fixture(t, { enqueuer });
  store.reserve(delivery, {
    candidateSha: trusted.workflow_run.head_sha,
    runId: String(trusted.workflow_run.id),
    runAttempt: String(trusted.workflow_run.run_attempt),
  });
  store.markSubmitted(delivery);

  assert.equal((await admission.handle(request())).body.code, 'reconcile_failed');
  const persisted = store.get(delivery);
  assert.equal(persisted.state, 'submitted');
  assert.equal(persisted.error_code, 'queue_multiple_matches');
  assert.equal(persisted.reconcile_count, 1);
  assert.ok(persisted.last_reconciled_at);
  assert.deepEqual(enqueuer.calls, { enqueue: 0, reconcile: 1 });
});
test('current delivery databases add the reconciliation audit counter in place', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'plane-webhook-current-'));
  const path = join(directory, 'deliveries.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const current = new DatabaseSync(path);
  current.exec(`
    CREATE TABLE webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      run_attempt TEXT NOT NULL,
      candidate_sha TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN ('dispatching', 'submitted', 'queued', 'running', 'completed', 'failed')
      ),
      retry_count INTEGER NOT NULL DEFAULT 0,
      retryable INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0, 1)),
      queue_id TEXT,
      queue_url TEXT,
      build_number TEXT,
      build_url TEXT,
      build_result TEXT,
      submitted_at TEXT,
      last_reconciled_at TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (run_id, run_attempt)
    ) STRICT;
  `);
  current.close();

  const migrated = new DeliveryStore(path);
  const columns = migrated.db.prepare(`PRAGMA table_info('webhook_deliveries')`).all();
  const counter = columns.find((column) => column.name === 'reconcile_count');
  assert.equal(counter?.notnull, 1);
  assert.equal(counter?.dflt_value, '0');
  migrated.close();
});
