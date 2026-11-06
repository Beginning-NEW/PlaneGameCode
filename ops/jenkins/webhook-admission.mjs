import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DELIVERY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const EXPECTED_REPOSITORY = 'Beginning-NEW/PlaneGameCode';
const EXPECTED_WORKFLOW = 'Checks';
const EXPECTED_WORKFLOW_PATH = '.github/workflows/checks.yml';

function response(status, code) {
  return { status, body: { code } };
}

function safeErrorCode(error) {
  const code = String(error?.code ?? 'dispatch_failed');
  return /^[a-z0-9_]{1,64}$/i.test(code) ? code : 'dispatch_failed';
}

export function verifySignature(rawBody, signature, secret) {
  if (!/^sha256=[0-9a-f]{64}$/i.test(signature ?? '') || !secret?.length) return false;
  const supplied = Buffer.from(signature.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function trustedWorkflowRun(event, payload) {
  const run = payload?.workflow_run ?? {};
  const runId = String(run.id ?? '');
  const runAttempt = String(run.run_attempt ?? '');
  const candidateSha = String(run.head_sha ?? '');
  if (
    event !== 'workflow_run' ||
    payload?.action !== 'completed' ||
    run.name !== EXPECTED_WORKFLOW ||
    run.path !== EXPECTED_WORKFLOW_PATH ||
    payload?.repository?.full_name !== EXPECTED_REPOSITORY ||
    run.head_repository?.full_name !== EXPECTED_REPOSITORY ||
    run.head_branch !== 'main' ||
    run.event !== 'push' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    !SHA_PATTERN.test(candidateSha) ||
    !POSITIVE_INTEGER_PATTERN.test(runId) ||
    !POSITIVE_INTEGER_PATTERN.test(runAttempt)
  ) return null;
  return { runId, runAttempt, candidateSha };
}

export class FileSecretProvider {
  constructor(path) {
    this.path = path;
  }

  get() {
    const secret = readFileSync(this.path);
    if (secret.length === 0) throw Object.assign(new Error('empty secret'), { code: 'secret_unavailable' });
    return secret;
  }
}

export class DeliveryStore {
  constructor(path, { now = () => new Date().toISOString() } = {}) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        run_attempt TEXT NOT NULL,
        candidate_sha TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('dispatching', 'queued', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        retryable INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0, 1)),
        queue_url TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (run_id, run_attempt)
      ) STRICT;
    `);
    this.db.prepare(`
      UPDATE webhook_deliveries
      SET state = 'failed', retryable = 1, error_code = 'gateway_restart_uncertain', updated_at = ?
      WHERE state = 'dispatching'
    `).run(this.now());
  }

  reserve(deliveryId, candidate) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existingDelivery = this.db.prepare(
        'SELECT * FROM webhook_deliveries WHERE delivery_id = ?',
      ).get(deliveryId);
      if (existingDelivery) {
        const sameIdentity = existingDelivery.run_id === candidate.runId &&
          existingDelivery.run_attempt === candidate.runAttempt &&
          existingDelivery.candidate_sha === candidate.candidateSha;
        if (!sameIdentity) {
          this.db.exec('COMMIT');
          return { action: 'reject', code: 'delivery_collision' };
        }
        if (existingDelivery.state === 'queued') {
          this.db.exec('COMMIT');
          return { action: 'duplicate', code: 'already_queued', record: existingDelivery };
        }
        if (existingDelivery.state === 'dispatching' || !existingDelivery.retryable) {
          this.db.exec('COMMIT');
          return { action: 'duplicate', code: 'dispatch_in_progress', record: existingDelivery };
        }
        const updatedAt = this.now();
        this.db.prepare(`
          UPDATE webhook_deliveries
          SET state = 'dispatching', retry_count = retry_count + 1, retryable = 0,
              error_code = NULL, updated_at = ?
          WHERE delivery_id = ?
        `).run(updatedAt, deliveryId);
        this.db.exec('COMMIT');
        return {
          action: 'retry',
          record: { ...existingDelivery, state: 'dispatching', retryable: 0, updated_at: updatedAt },
        };
      }

      const existingRun = this.db.prepare(
        'SELECT * FROM webhook_deliveries WHERE run_id = ? AND run_attempt = ?',
      ).get(candidate.runId, candidate.runAttempt);
      if (existingRun) {
        this.db.exec('COMMIT');
        return { action: 'duplicate', code: 'run_already_reserved', record: existingRun };
      }

      const timestamp = this.now();
      this.db.prepare(`
        INSERT INTO webhook_deliveries (
          delivery_id, run_id, run_attempt, candidate_sha, state, retryable, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'dispatching', 0, ?, ?)
      `).run(
        deliveryId,
        candidate.runId,
        candidate.runAttempt,
        candidate.candidateSha,
        timestamp,
        timestamp,
      );
      this.db.exec('COMMIT');
      return { action: 'dispatch' };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  markQueued(deliveryId, queueUrl) {
    const result = this.db.prepare(`
      UPDATE webhook_deliveries
      SET state = 'queued', retryable = 0, queue_url = ?, error_code = NULL, updated_at = ?
      WHERE delivery_id = ? AND state = 'dispatching'
    `).run(queueUrl, this.now(), deliveryId);
    if (result.changes !== 1) throw Object.assign(new Error('state transition failed'), { code: 'state_write_failed' });
  }

  markFailed(deliveryId, errorCode) {
    const result = this.db.prepare(`
      UPDATE webhook_deliveries
      SET state = 'failed', retryable = 1, error_code = ?, updated_at = ?
      WHERE delivery_id = ? AND state = 'dispatching'
    `).run(errorCode, this.now(), deliveryId);
    if (result.changes !== 1) throw Object.assign(new Error('state transition failed'), { code: 'state_write_failed' });
  }

  get(deliveryId) {
    return this.db.prepare('SELECT * FROM webhook_deliveries WHERE delivery_id = ?').get(deliveryId);
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }
}

export class WebhookAdmission {
  constructor({ webhookSecretProvider, store, enqueuer, logger = () => {} }) {
    this.webhookSecretProvider = webhookSecretProvider;
    this.store = store;
    this.enqueuer = enqueuer;
    this.logger = logger;
  }

  async handle({ rawBody, signature, deliveryId, event }) {
    let secret;
    try {
      secret = this.webhookSecretProvider.get();
    } catch {
      this.logger({ outcome: 'rejected', code: 'signature_unavailable' });
      return response(503, 'signature_unavailable');
    }
    if (!verifySignature(rawBody, signature, secret)) {
      this.logger({ outcome: 'rejected', code: 'invalid_signature' });
      return response(401, 'invalid_signature');
    }
    if (!DELIVERY_PATTERN.test(deliveryId ?? '')) {
      this.logger({ outcome: 'rejected', code: 'invalid_delivery' });
      return response(400, 'invalid_delivery');
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      this.logger({ outcome: 'rejected', code: 'invalid_json' });
      return response(400, 'invalid_json');
    }
    const candidate = trustedWorkflowRun(event, payload);
    if (!candidate) {
      this.logger({ outcome: 'rejected', code: 'untrusted_workflow_run' });
      return response(202, 'ignored');
    }

    let reservation;
    try {
      reservation = this.store.reserve(deliveryId, candidate);
    } catch {
      this.logger({ outcome: 'failed', code: 'reservation_failed' });
      return response(503, 'reservation_failed');
    }
    if (reservation.action === 'reject') {
      this.logger({ outcome: 'rejected', code: reservation.code });
      return response(409, reservation.code);
    }
    if (reservation.action === 'duplicate') {
      this.logger({ outcome: 'duplicate', code: reservation.code });
      return response(202, reservation.code);
    }

    let enqueueConfirmed = false;
    try {
      if (reservation.action === 'retry') {
        const reconciled = await this.enqueuer.reconcile(deliveryId);
        if (reconciled) {
          this.store.markQueued(deliveryId, reconciled.queueUrl);
          this.logger({ outcome: 'reconciled', code: 'already_queued' });
          return response(202, 'already_queued');
        }
      }
      const queued = await this.enqueuer.enqueue({ deliveryId, ...candidate });
      enqueueConfirmed = true;
      this.store.markQueued(deliveryId, queued.queueUrl);
      this.logger({ outcome: 'queued', code: 'queued' });
      return response(202, 'queued');
    } catch (error) {
      const errorCode = safeErrorCode(error);
      try {
        this.store.markFailed(deliveryId, errorCode);
      } catch {
        this.logger({ outcome: 'failed', code: 'state_write_failed' });
        return response(503, 'state_write_failed');
      }
      const responseCode = enqueueConfirmed ? 'state_write_failed' : 'enqueue_failed';
      this.logger({ outcome: 'failed', code: responseCode });
      return response(503, responseCode);
    }
  }
}
