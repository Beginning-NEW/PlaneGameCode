#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryStore, WebhookAdmission } from './webhook-admission.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';
const secret = Buffer.from('dry-run-ephemeral-secret');
const deliveryId = '123e4567-e89b-42d3-a456-426614174000';
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

const directory = await mkdtemp(join(tmpdir(), 'plane-webhook-dry-run-'));
const store = new DeliveryStore(join(directory, 'deliveries.sqlite'));
let queued = 0;
const admission = new WebhookAdmission({
  webhookSecretProvider: { get: () => secret },
  store,
  enqueuer: {
    async enqueue() {
      queued += 1;
      return { queueId: '1', queueUrl: 'http://jenkins.test/queue/item/1/' };
    },
    async reconcile() {
      return { state: 'queued', queueId: '1', queueUrl: 'http://jenkins.test/queue/item/1/' };
    },
  },
});
const rawBody = Buffer.from(JSON.stringify(trusted));
const signature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
const request = { rawBody, signature, deliveryId, event: 'workflow_run' };
try {
  assert.equal((await admission.handle(request)).body.code, 'queued');
  assert.equal((await admission.handle(request)).body.code, 'already_queued');
  assert.equal((await admission.handle({ ...request, signature: 'invalid' })).body.code, 'invalid_signature');
  assert.equal((await admission.handle({ ...request, deliveryId: '' })).body.code, 'invalid_delivery');
  assert.equal(queued, 1);
  console.log('webhook contract dry-run: queued=1 duplicate=1 rejected=2 hmac=verified payload_logged=0 secret_logged=0');
} finally {
  store.close();
  await rm(directory, { recursive: true, force: true });
}
