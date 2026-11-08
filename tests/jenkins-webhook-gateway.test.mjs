import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JenkinsEnqueuer } from '../ops/jenkins/webhook-gateway.mjs';
import { JenkinsApiTokenProvider } from '../ops/jenkins/webhook-admission.mjs';

const baseUrl = 'http://jenkins.test';
const deliveryId = '123e4567-e89b-42d3-a456-426614174000';
const candidateSha = '0123456789abcdef0123456789abcdef01234567';
const runId = '123';
const runAttempt = '1';
const actions = [{
  parameters: [
    { name: 'CANDIDATE_SHA', value: candidateSha },
    { name: 'ACTIONS_RUN_ID', value: runId },
    { name: 'ACTIONS_RUN_ATTEMPT', value: runAttempt },
    { name: 'WEBHOOK_DELIVERY', value: deliveryId },
  ],
}];

test('gateway token consumer reads one complete atomic generation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'plane-gateway-token-'));
  const path = join(directory, 'jenkins-api-token');
  const uuid = '123e4567-e89b-42d3-a456-426614174000';
  const first = { version: 1, token: 'ABCDEFGHIJKLMNOP', uuid };
  const second = { version: 1, token: 'QRSTUVWXYZabcdef', uuid };
  try {
    writeFileSync(path, JSON.stringify(first), { mode: 0o600 });
    const provider = new JenkinsApiTokenProvider(path);
    assert.equal(provider.get().toString(), first.token);
    writeFileSync(`${path}.new`, JSON.stringify(second), { mode: 0o600 });
    renameSync(`${path}.new`, path);
    assert.equal(provider.get().toString(), second.token);
    writeFileSync(`${path}.bad`, '{not-json', { mode: 0o600 });
    renameSync(`${path}.bad`, path);
    assert.throws(() => provider.get(), (error) => error.code === 'credential_unavailable');
  } finally {
    rmSync(directory, { recursive: true });
  }
});

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fixture(responses) {
  const calls = [];
  const enqueuer = new JenkinsEnqueuer({
    baseUrl,
    user: 'gateway',
    tokenProvider: { get: () => Buffer.from('test-token') },
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method ?? 'GET' });
      const next = responses.shift();
      if (!next) throw new Error('unexpected request');
      return typeof next === 'function' ? next(url, options) : next;
    },
  });
  return { enqueuer, calls };
}

function record(overrides = {}) {
  return {
    delivery_id: deliveryId,
    candidate_sha: candidateSha,
    run_id: runId,
    run_attempt: runAttempt,
    state: 'submitted',
    queue_id: null,
    queue_url: null,
    ...overrides,
  };
}

test('enqueue accepts only a same-origin numeric queue Location and persists its identity', async () => {
  const accepted = fixture([new Response(null, {
    status: 201,
    headers: { location: '/queue/item/42/' },
  })]);
  assert.deepEqual(await accepted.enqueuer.enqueue({
    candidateSha: '0123456789abcdef0123456789abcdef01234567',
    runId: '123',
    runAttempt: '1',
    deliveryId,
  }), { queueId: '42', queueUrl: 'http://jenkins.test/queue/item/42/' });
  assert.equal(accepted.calls.length, 1);
  assert.equal(accepted.calls[0].method, 'POST');

  const rejected = fixture([new Response(null, {
    status: 201,
    headers: { location: 'https://attacker.test/queue/item/42/' },
  })]);
  await assert.rejects(
    rejected.enqueuer.enqueue({
      candidateSha: '0123456789abcdef0123456789abcdef01234567',
      runId: '123',
      runAttempt: '1',
      deliveryId,
    }),
    (error) => error.code === 'invalid_queue_location',
  );

  const wrongResource = fixture([new Response(null, {
    status: 201,
    headers: { location: '/job/plane-game/job/main-cd/17/' },
  })]);
  await assert.rejects(
    wrongResource.enqueuer.enqueue({
      candidateSha: '0123456789abcdef0123456789abcdef01234567',
      runId: '123',
      runAttempt: '1',
      deliveryId,
    }),
    (error) => error.code === 'invalid_queue_location',
  );
});

test('a persisted queue item transitions from queued to running using its executable identity', async () => {
  const pending = fixture([json({
    id: 42,
    url: `${baseUrl}/queue/item/42/`,
    task: { url: `${baseUrl}/job/plane-game/job/main-cd/` },
    actions,
  })]);
  assert.deepEqual(await pending.enqueuer.reconcile(record({
    state: 'queued',
    queue_id: '42',
    queue_url: `${baseUrl}/queue/item/42/`,
  })), {
    state: 'queued',
    queueId: '42',
    queueUrl: `${baseUrl}/queue/item/42/`,
  });

  const left = fixture([json({
    id: 42,
    url: `${baseUrl}/queue/item/42/`,
    task: { url: `${baseUrl}/job/plane-game/job/main-cd/` },
    executable: { number: 17, url: `${baseUrl}/job/plane-game/job/main-cd/17/` },
    actions,
  })]);
  assert.deepEqual(await left.enqueuer.reconcile(record({
    state: 'queued',
    queue_id: '42',
    queue_url: `${baseUrl}/queue/item/42/`,
  })), {
    state: 'running',
    queueId: '42',
    queueUrl: `${baseUrl}/queue/item/42/`,
    buildNumber: '17',
    buildUrl: `${baseUrl}/job/plane-game/job/main-cd/17/`,
    buildResult: null,
  });
});

test('a left queue item reconciles to a completed build without another POST', async () => {
  const completed = fixture([
    json({}, 404),
    json({ items: [] }),
    json({ builds: [{
      number: 17,
      url: `${baseUrl}/job/plane-game/job/main-cd/17/`,
      building: false,
      result: 'SUCCESS',
      actions,
    }] }),
  ]);
  assert.deepEqual(await completed.enqueuer.reconcile(record({
    state: 'queued',
    queue_id: '42',
    queue_url: `${baseUrl}/queue/item/42/`,
  })), {
    state: 'completed',
    queueId: '42',
    queueUrl: `${baseUrl}/queue/item/42/`,
    buildNumber: '17',
    buildUrl: `${baseUrl}/job/plane-game/job/main-cd/17/`,
    buildResult: 'SUCCESS',
  });
  assert.deepEqual(completed.calls.map((call) => call.method), ['GET', 'GET', 'GET']);
});

test('the queue-left visibility gap remains unknown and never becomes evidence for another POST', async () => {
  const gap = fixture([
    json({}, 404),
    json({ items: [] }),
    json({ builds: [] }),
  ]);
  assert.equal(await gap.enqueuer.reconcile(record({
    state: 'queued',
    queue_id: '42',
    queue_url: `${baseUrl}/queue/item/42/`,
  })), null);
  assert.deepEqual(gap.calls.map((call) => call.method), ['GET', 'GET', 'GET']);
});
test('direct queue reconciliation requires the complete immutable candidate tuple', async () => {
  const mismatched = fixture([json({
    id: 42,
    url: `${baseUrl}/queue/item/42/`,
    task: { url: `${baseUrl}/job/plane-game/job/main-cd/` },
    actions: [{ parameters: [
      { name: 'CANDIDATE_SHA', value: 'f'.repeat(40) },
      ...actions[0].parameters.slice(1),
    ] }],
  })]);
  await assert.rejects(
    mismatched.enqueuer.reconcile(record({
      state: 'queued',
      queue_id: '42',
      queue_url: `${baseUrl}/queue/item/42/`,
    })),
    (error) => error.code === 'queue_candidate_mismatch',
  );
});

test('fallback reconciliation rejects multiple complete candidate matches', async () => {
  const item = (id) => ({
    id,
    url: `${baseUrl}/queue/item/${id}/`,
    task: { url: `${baseUrl}/job/plane-game/job/main-cd/` },
    actions,
  });
  const duplicateQueue = fixture([json({ items: [item(41), item(42)] })]);
  await assert.rejects(
    duplicateQueue.enqueuer.reconcile(record()),
    (error) => error.code === 'queue_multiple_matches',
  );

  const build = (number) => ({
    number,
    url: `${baseUrl}/job/plane-game/job/main-cd/${number}/`,
    building: true,
    result: null,
    actions,
  });
  const duplicateBuild = fixture([
    json({ items: [] }),
    json({ builds: [build(17), build(18)] }),
  ]);
  await assert.rejects(
    duplicateBuild.enqueuer.reconcile(record()),
    (error) => error.code === 'build_multiple_matches',
  );
});

test('fallback reconciliation cannot rebind a persisted queue identity', async () => {
  const rebound = fixture([
    json({}, 404),
    json({ items: [{
      id: 99,
      url: `${baseUrl}/queue/item/99/`,
      task: { url: `${baseUrl}/job/plane-game/job/main-cd/` },
      actions,
    }] }),
  ]);
  await assert.rejects(
    rebound.enqueuer.reconcile(record({
      state: 'queued',
      queue_id: '42',
      queue_url: `${baseUrl}/queue/item/42/`,
    })),
    (error) => error.code === 'queue_identity_mismatch',
  );
});
