import { createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';

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
    try {
      const uid = process.getuid();
      const parent = lstatSync(dirname(this.path));
      if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o777) !== 0o700) {
        throw new Error('invalid secret directory');
      }
      const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const file = fstatSync(fd);
        if (!file.isFile() || file.nlink !== 1 || file.uid !== uid ||
            (file.mode & 0o777) !== 0o600 || file.size === 0 || file.size > 4096) {
          throw new Error('invalid secret file');
        }
        const secret = readFileSync(fd);
        if (secret.length !== file.size) throw new Error('secret changed during read');
        return secret;
      } finally {
        closeSync(fd);
      }
    } catch {
      throw Object.assign(new Error('secret unavailable'), { code: 'secret_unavailable' });
    }
  }
}

export class JenkinsApiTokenProvider extends FileSecretProvider {
  get() {
    try {
      const parent = lstatSync(dirname(this.path));
      if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700) {
        throw new Error('invalid token metadata');
      }
      const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let raw;
      try {
        const file = fstatSync(fd);
        if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid() ||
            (file.mode & 0o777) !== 0o600) throw new Error('invalid token metadata');
        raw = readFileSync(fd);
      } finally {
        closeSync(fd);
      }
      if (raw.length > 4096) throw new Error('invalid token document');
      const value = JSON.parse(raw.toString('utf8'));
      if (value?.version !== 1 || Object.keys(value).sort().join(',') !== 'token,uuid,version' ||
          !/^[0-9a-zA-Z]{16,256}$/.test(value.token) ||
          !/^[0-9a-fA-F-]{36}$/.test(value.uuid)) {
        throw new Error('invalid token document');
      }
      return Buffer.from(value.token, 'ascii');
    } catch {
      throw Object.assign(new Error('invalid token document'), { code: 'credential_unavailable' });
    }
  }
}

export class DeliveryStore {
  constructor(path, { now = () => new Date().toISOString() } = {}) {
    this.path = path;
    this.now = now;
    this.db = this.openConnection();
    let columns = this.db.prepare(`PRAGMA table_info('webhook_deliveries')`).all();
    if (columns.length > 0 && !columns.some((column) => column.name === 'queue_id')) {
      this.migrateLegacySchema();
    }
    this.createSchema();
    columns = this.db.prepare(`PRAGMA table_info('webhook_deliveries')`).all();
    if (!columns.some((column) => column.name === 'reconcile_count')) {
      this.db.exec(`
        ALTER TABLE webhook_deliveries
        ADD COLUMN reconcile_count INTEGER NOT NULL DEFAULT 0;
      `);
    }
    this.db.prepare(`
      UPDATE webhook_deliveries
      SET state = 'failed', retryable = 1, error_code = 'gateway_restart_before_submit', updated_at = ?
      WHERE state = 'dispatching'
    `).run(this.now());
  }

  openConnection() {
    const db = new DatabaseSync(this.path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    return db;
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
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
        reconcile_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (run_id, run_attempt)
      ) STRICT;
    `);
  }

  migrateLegacySchema() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('ALTER TABLE webhook_deliveries RENAME TO webhook_deliveries_legacy');
      this.createSchema();
      this.db.exec(`
        INSERT INTO webhook_deliveries (
          delivery_id, run_id, run_attempt, candidate_sha, state, retry_count, retryable,
          queue_url, submitted_at, error_code, created_at, updated_at
        )
        SELECT
          delivery_id, run_id, run_attempt, candidate_sha,
          CASE WHEN state = 'queued' THEN 'queued' ELSE 'submitted' END,
          retry_count, 0, queue_url,
          CASE WHEN state = 'queued' THEN NULL ELSE updated_at END,
          CASE WHEN state = 'queued' THEN error_code ELSE 'legacy_outcome_unknown' END,
          created_at, updated_at
        FROM webhook_deliveries_legacy;
        DROP TABLE webhook_deliveries_legacy;
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
        if (existingDelivery.state === 'completed') {
          this.db.exec('COMMIT');
          return { action: 'duplicate', code: 'already_completed', record: existingDelivery };
        }
        if (['submitted', 'queued', 'running'].includes(existingDelivery.state)) {
          this.db.exec('COMMIT');
          return { action: 'reconcile', record: existingDelivery };
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

  markSubmitted(deliveryId) {
    const timestamp = this.now();
    const result = this.db.prepare(`
      UPDATE webhook_deliveries
      SET state = 'submitted', retryable = 0, submitted_at = ?,
          error_code = 'enqueue_outcome_pending', updated_at = ?
      WHERE delivery_id = ? AND state = 'dispatching'
    `).run(timestamp, timestamp, deliveryId);
    if (result.changes !== 1) throw Object.assign(new Error('state transition failed'), { code: 'state_write_failed' });
  }

  markQueued(deliveryId, queue) {
    return this.recordReconciliation(deliveryId, { ...queue, state: 'queued' }, {
      incrementAttempt: false,
    });
  }

  recordReconciliation(deliveryId, observation, { incrementAttempt = true } = {}) {
    const ranks = { submitted: 0, queued: 1, running: 2, completed: 3 };
    if (!Object.hasOwn(ranks, observation?.state)) {
      throw Object.assign(new Error('invalid reconciliation state'), { code: 'state_write_failed' });
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.get(deliveryId);
      if (!existing || !Object.hasOwn(ranks, existing.state)) {
        throw Object.assign(new Error('state transition failed'), { code: 'state_write_failed' });
      }
      const identityFields = [
        ['queue_id', 'queueId'],
        ['queue_url', 'queueUrl'],
        ['build_number', 'buildNumber'],
        ['build_url', 'buildUrl'],
      ];
      for (const [storedField, observedField] of identityFields) {
        const stored = existing[storedField];
        const observed = observation[observedField];
        if (stored != null && observed != null && stored !== observed) {
          throw Object.assign(new Error('immutable Jenkins identity mismatch'), {
            code: 'observation_identity_mismatch',
          });
        }
      }
      if ((observation.queueId == null) !== (observation.queueUrl == null) ||
          (observation.buildNumber == null) !== (observation.buildUrl == null)) {
        throw Object.assign(new Error('incomplete Jenkins identity'), {
          code: 'observation_identity_mismatch',
        });
      }
      if (existing.build_result != null && observation.buildResult != null &&
          existing.build_result !== observation.buildResult) {
        throw Object.assign(new Error('immutable Jenkins result mismatch'), {
          code: 'observation_identity_mismatch',
        });
      }
      const state = ranks[observation.state] > ranks[existing.state] ? observation.state : existing.state;
      const timestamp = this.now();
      this.db.prepare(`
        UPDATE webhook_deliveries
        SET state = ?, retryable = 0,
            queue_id = COALESCE(queue_id, ?), queue_url = COALESCE(queue_url, ?),
            build_number = COALESCE(build_number, ?), build_url = COALESCE(build_url, ?),
            build_result = COALESCE(?, build_result), last_reconciled_at = ?,
            reconcile_count = reconcile_count + ?,
            error_code = NULL, updated_at = ?
        WHERE delivery_id = ?
      `).run(
        state, observation.queueId ?? null, observation.queueUrl ?? null,
        observation.buildNumber ?? null, observation.buildUrl ?? null,
        observation.buildResult ?? null,
        incrementAttempt ? timestamp : existing.last_reconciled_at,
        incrementAttempt ? 1 : 0,
        timestamp, deliveryId,
      );
      this.db.exec('COMMIT');
      return this.get(deliveryId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error?.code === 'observation_identity_mismatch') {
        try {
          this.recordReconciliationError(deliveryId, error.code);
          error.auditRecorded = true;
        } catch (auditError) {
          throw Object.assign(new Error('audit persistence failed'), {
            code: 'audit_persistence_failed',
            cause: auditError,
          });
        }
      }
      throw error;
    }
  }

  recordReconciliationPending(deliveryId, errorCode) {
    return this.recordReconciliationError(deliveryId, errorCode);
  }

  recordReconciliationError(deliveryId, errorCode) {
    const timestamp = this.now();
    try {
      return this.writeReconciliationError(this.db, deliveryId, errorCode, timestamp);
    } catch (primaryError) {
      let recoveryDb;
      try {
        recoveryDb = this.openConnection();
        const record = this.writeReconciliationError(recoveryDb, deliveryId, errorCode, timestamp);
        const failedDb = this.db;
        this.db = recoveryDb;
        recoveryDb = null;
        if (failedDb.isOpen) failedDb.close();
        return record;
      } catch (recoveryError) {
        throw Object.assign(new Error('audit persistence failed'), {
          code: 'audit_persistence_failed',
          cause: recoveryError,
          primaryError,
        });
      } finally {
        if (recoveryDb?.isOpen) recoveryDb.close();
      }
    }
  }

  writeReconciliationError(db, deliveryId, errorCode, timestamp) {
    const result = db.prepare(`
      UPDATE webhook_deliveries
      SET retryable = 0, last_reconciled_at = ?, reconcile_count = reconcile_count + 1,
          error_code = ?, updated_at = ?
      WHERE delivery_id = ? AND state IN ('submitted', 'queued', 'running')
    `).run(timestamp, errorCode, timestamp, deliveryId);
    if (result.changes !== 1) {
      throw Object.assign(new Error('state transition failed'), { code: 'state_write_failed' });
    }
    return db.prepare('SELECT * FROM webhook_deliveries WHERE delivery_id = ?').get(deliveryId);
  }

  markSubmissionError(deliveryId, errorCode) {
    const result = this.db.prepare(`
      UPDATE webhook_deliveries
      SET error_code = ?, updated_at = ?
      WHERE delivery_id = ? AND state = 'submitted'
    `).run(errorCode, this.now(), deliveryId);
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

  recordAudit(deliveryId, code) {
    try {
      this.store.recordReconciliationError(deliveryId, code);
      return true;
    } catch {
      this.logger({ outcome: 'failed', code: 'audit_persistence_failed' });
      return false;
    }
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

    if (reservation.action === 'reconcile') {
      try {
        const reconciled = await this.enqueuer.reconcile(reservation.record);
        if (!reconciled) {
          const code = reservation.record.state === 'submitted' ? 'submitted_unknown' : 'queue_state_unknown';
          this.store.recordReconciliationPending(deliveryId, code);
          this.logger({ outcome: 'pending', code });
          return response(202, code);
        }
        const record = this.store.recordReconciliation(deliveryId, reconciled);
        const code = record.state === 'queued' ? 'already_queued' : record.state;
        this.logger({ outcome: 'reconciled', code });
        return response(202, code);
      } catch (error) {
        if (error?.code === 'audit_persistence_failed' ||
            (!error?.auditRecorded && !this.recordAudit(deliveryId, safeErrorCode(error)))) {
          if (error?.code === 'audit_persistence_failed') {
            this.logger({ outcome: 'failed', code: 'audit_persistence_failed' });
          }
          return response(503, 'audit_persistence_failed');
        }
        this.logger({ outcome: 'failed', code: 'reconcile_failed' });
        return response(503, 'reconcile_failed');
      }
    }

    try {
      this.store.markSubmitted(deliveryId);
    } catch {
      try {
        this.store.markFailed(deliveryId, 'submission_state_write_failed');
      } catch {}
      this.logger({ outcome: 'failed', code: 'state_write_failed' });
      return response(503, 'state_write_failed');
    }

    let queued;
    try {
      queued = await this.enqueuer.enqueue({ deliveryId, ...candidate });
    } catch (error) {
      if (!this.recordAudit(deliveryId, safeErrorCode(error))) {
        return response(503, 'audit_persistence_failed');
      }
      this.logger({ outcome: 'pending', code: 'enqueue_outcome_unknown' });
      return response(503, 'enqueue_outcome_unknown');
    }

    try {
      this.store.markQueued(deliveryId, queued);
    } catch {
      if (!this.recordAudit(deliveryId, 'queue_identity_persistence_failed')) {
        return response(503, 'audit_persistence_failed');
      }
      this.logger({ outcome: 'failed', code: 'state_write_failed' });
      return response(503, 'state_write_failed');
    }
    this.logger({ outcome: 'queued', code: 'queued' });
    return response(202, 'queued');
  }
}
