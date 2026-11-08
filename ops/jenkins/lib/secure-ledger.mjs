import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const ZERO_HASH = '0'.repeat(64);
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const WINDOW_MS = 60 * 60 * 1000;
const REQUEST_LIMIT = 30;
const CANDIDATE_RESERVATION = 15;

function ledgerError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

function initialState() {
  return {
    clock: { lastMs: null, backoffUntilMs: 0 },
    rate: null,
    budget: { requests: [], candidates: [], reservations: {} },
    discovery: { etag: null, lastTriggerId: null },
    poller: {},
    deployments: {},
  };
}

function assertDirectory(path, uid) {
  const metadata = lstatSync(path);
  const permissionsInvalid = process.platform !== 'win32' &&
    (metadata.uid !== uid || (metadata.mode & 0o777) !== 0o700);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || permissionsInvalid) {
    throw ledgerError('ledger_directory_unsafe');
  }
}

function assertRegular(metadata, uid) {
  const permissionsInvalid = process.platform !== 'win32' &&
    (metadata.uid !== uid || (metadata.mode & 0o777) !== 0o600);
  if (!metadata.isFile() || metadata.nlink !== 1 || permissionsInvalid) {
    throw ledgerError('ledger_file_unsafe');
  }
}

function openRegular(path, flags, uid) {
  let fd;
  try {
    fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  } catch {
    throw ledgerError('ledger_file_unsafe');
  }
  try {
    assertRegular(fstatSync(fd), uid);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readRegular(path, uid) {
  const fd = openRegular(path, constants.O_RDONLY, uid);
  try {
    const metadata = fstatSync(fd);
    if (metadata.size > MAX_LEDGER_BYTES) throw ledgerError('ledger_too_large');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function atomicWrite(path, value, uid) {
  const parent = dirname(path);
  assertDirectory(parent, uid);
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, value, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (existsSync(path)) assertRegular(lstatSync(path), uid);
    renameSync(temporary, path);
    fsyncDirectory(parent);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function validateSnapshot(value) {
  if (value?.version !== 1 || !Number.isSafeInteger(value.seq) || value.seq < 0 ||
      !/^[0-9a-f]{64}$/.test(value.head ?? '') || !value.state || typeof value.state !== 'object') {
    throw ledgerError('snapshot_malformed');
  }
  return value;
}

function parseJournal(text) {
  if (text === '') return [];
  if (!text.endsWith('\n')) throw ledgerError('journal_truncated');
  return text.trimEnd().split('\n').map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      throw ledgerError('journal_malformed');
    }
  });
}

function verifyJournal(entries) {
  let previous = ZERO_HASH;
  let expectedSeq = 1;
  for (const entry of entries) {
    const { hash, ...unsigned } = entry ?? {};
    if (entry?.version !== 1 || entry.seq !== expectedSeq || entry.prevHash !== previous ||
        !Number.isSafeInteger(entry.atMs) || entry.atMs < 0 || typeof entry.type !== 'string' ||
        !entry.state || typeof entry.state !== 'object' || digest(unsigned) !== hash) {
      throw ledgerError('journal_corrupt');
    }
    previous = hash;
    expectedSeq += 1;
  }
  return previous;
}

function assertClock(state, nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw ledgerError('clock_invalid');
  if (state.clock.lastMs !== null && nowMs < state.clock.lastMs) {
    throw ledgerError('clock_regression');
  }
  state.clock.lastMs = nowMs;
}

function pruneBudget(state, nowMs) {
  const floor = nowMs - WINDOW_MS;
  state.budget.requests = state.budget.requests.filter((time) => time > floor);
  state.budget.candidates = state.budget.candidates.filter((entry) => entry.atMs > floor);
  for (const [key, reservation] of Object.entries(state.budget.reservations)) {
    if (reservation.atMs <= floor) delete state.budget.reservations[key];
  }
}

function reservedCount(state) {
  return Object.values(state.budget.reservations)
    .reduce((total, reservation) => total + reservation.remaining, 0);
}

export class SecureLedger {
  static initialize(root, { uid = process.getuid?.() ?? 0 } = {}) {
    if (!Number.isInteger(uid)) throw ledgerError('uid_unavailable');
    if (!existsSync(root)) mkdirSync(root, { mode: 0o700, recursive: false });
    assertDirectory(root, uid);
    const journalPath = join(root, 'journal.ndjson');
    const snapshotPath = join(root, 'snapshot.json');
    const lockPath = join(root, '.shared.lock');
    if (existsSync(journalPath) || existsSync(snapshotPath) || existsSync(lockPath)) throw ledgerError('ledger_already_initialized');
    let fd = openSync(journalPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    const state = initialState();
    atomicWrite(snapshotPath, `${canonical({ version: 1, seq: 0, head: ZERO_HASH, state })}\n`, uid);
    fd = openSync(lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fsyncDirectory(root);
  }

  constructor(root, { uid = process.getuid?.() ?? 0, now = () => Date.now() } = {}) {
    if (!Number.isInteger(uid)) throw ledgerError('uid_unavailable');
    this.root = root;
    this.uid = uid;
    this.now = now;
    this.journalPath = join(root, 'journal.ndjson');
    this.snapshotPath = join(root, 'snapshot.json');
    this.lockPath = join(root, '.shared.lock');
    this.load();
  }

  load() {
    assertDirectory(this.root, this.uid);
    if (!existsSync(this.journalPath) || !existsSync(this.snapshotPath) || !existsSync(this.lockPath)) {
      throw ledgerError('ledger_not_initialized');
    }
    if (readRegular(this.lockPath, this.uid) !== '') throw ledgerError('ledger_lock_unsafe');
    const entries = parseJournal(readRegular(this.journalPath, this.uid));
    const head = verifyJournal(entries);
    const snapshot = validateSnapshot(JSON.parse(readRegular(this.snapshotPath, this.uid)));
    if (snapshot.seq > entries.length) throw ledgerError('snapshot_ahead_of_journal');
    const prefixHead = snapshot.seq === 0 ? ZERO_HASH : entries[snapshot.seq - 1].hash;
    const prefixState = snapshot.seq === 0 ? initialState() : entries[snapshot.seq - 1].state;
    if (snapshot.head !== prefixHead || canonical(snapshot.state) !== canonical(prefixState)) {
      throw ledgerError('snapshot_journal_mismatch');
    }
    const latestState = entries.length === 0 ? snapshot.state : entries.at(-1).state;
    if (snapshot.seq < entries.length) {
      atomicWrite(this.snapshotPath,
        `${canonical({ version: 1, seq: entries.length, head, state: latestState })}\n`, this.uid);
    }
    this.seq = entries.length;
    this.head = head;
    this.state = clone(latestState);
    return clone(this.state);
  }

  mutate(type, payload, update) {
    this.load();
    const next = clone(this.state);
    const result = update(next);
    const atMs = this.now();
    assertClock(next, atMs);
    const unsigned = {
      version: 1,
      seq: this.seq + 1,
      atMs,
      type,
      payload: payload ?? null,
      state: next,
      prevHash: this.head,
    };
    const entry = { ...unsigned, hash: digest(unsigned) };
    const fd = openRegular(this.journalPath, constants.O_WRONLY | constants.O_APPEND, this.uid);
    try {
      writeSync(fd, `${canonical(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    atomicWrite(this.snapshotPath,
      `${canonical({ version: 1, seq: entry.seq, head: entry.hash, state: next })}\n`, this.uid);
    this.seq = entry.seq;
    this.head = entry.hash;
    this.state = next;
    return result;
  }

  recordRequest(reservationId = null) {
    return this.mutate('request_reserved', { reservationId }, (state) => {
      const nowMs = this.now();
      assertClock(state, nowMs);
      pruneBudget(state, nowMs);
      if (nowMs < state.clock.backoffUntilMs) throw ledgerError('request_backoff_active');
      if (reservationId) {
        const reservation = state.budget.reservations[reservationId];
        if (!reservation || reservation.remaining < 1) throw ledgerError('request_reservation_exhausted');
        reservation.remaining -= 1;
      } else if (state.budget.requests.length + reservedCount(state) + 1 > REQUEST_LIMIT) {
        throw ledgerError('request_budget_exhausted');
      }
      state.budget.requests.push(nowMs);
      return { used: state.budget.requests.length, reserved: reservedCount(state) };
    });
  }

  admitCandidate(triggerId, githubRemaining) {
    return this.mutate('candidate_admitted', { triggerId, githubRemaining }, (state) => {
      const nowMs = this.now();
      assertClock(state, nowMs);
      pruneBudget(state, nowMs);
      if (state.budget.candidates.length !== 0) throw ledgerError('candidate_hourly_limit');
      if (!Number.isSafeInteger(githubRemaining) || githubRemaining < 46) {
        throw ledgerError('github_reserve_insufficient');
      }
      if (state.budget.requests.length + reservedCount(state) + CANDIDATE_RESERVATION > REQUEST_LIMIT) {
        throw ledgerError('request_budget_insufficient');
      }
      if (state.budget.reservations[triggerId]) throw ledgerError('candidate_already_reserved');
      state.budget.candidates.push({ triggerId, atMs: nowMs });
      state.budget.reservations[triggerId] = { atMs: nowMs, remaining: CANDIDATE_RESERVATION };
      return clone(state.budget.reservations[triggerId]);
    });
  }

  cancelReservation(triggerId, reason) {
    return this.mutate('reservation_cancelled', { triggerId, reason }, (state) => {
      const reservation = state.budget.reservations[triggerId];
      if (reservation) reservation.remaining = 0;
    });
  }

  observeRate({ limit, remaining, resetMs }) {
    return this.mutate('rate_observed', { limit, remaining, resetMs }, (state) => {
      const nowMs = this.now();
      assertClock(state, nowMs);
      if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(remaining) ||
          remaining < 0 || remaining > limit || !Number.isSafeInteger(resetMs) || resetMs <= nowMs) {
        state.clock.backoffUntilMs = Math.max(state.clock.backoffUntilMs, nowMs + WINDOW_MS);
        throw ledgerError('rate_headers_invalid');
      }
      if (state.rate && resetMs < state.rate.resetMs && remaining > state.rate.remaining) {
        state.clock.backoffUntilMs = Math.max(state.clock.backoffUntilMs, state.rate.resetMs);
        throw ledgerError('rate_headers_inconsistent');
      }
      state.rate = { limit, remaining, resetMs, observedAtMs: nowMs };
      return clone(state.rate);
    });
  }

  defer(untilMs, reason) {
    return this.mutate('backoff_set', { untilMs, reason }, (state) => {
      const nowMs = this.now();
      assertClock(state, nowMs);
      const safeUntil = Number.isSafeInteger(untilMs) && untilMs > nowMs ? untilMs : nowMs + WINDOW_MS;
      state.clock.backoffUntilMs = Math.max(state.clock.backoffUntilMs, safeUntil);
    });
  }

  setDiscovery({ etag, triggerId }) {
    return this.mutate('discovery_recorded', { triggerId }, (state) => {
      state.discovery = { etag, lastTriggerId: triggerId };
    });
  }

  transitionPoller(triggerId, nextState, evidence = {}) {
    const ranks = {
      observed: 0,
      eligible: 1,
      post_intent: 2,
      queued: 3,
      building: 4,
      deploy_claimed: 5,
      succeeded: 6,
      failed: 6,
      quarantined: 6,
    };
    return this.mutate('poller_transition', { triggerId, nextState }, (state) => {
      if (!Object.hasOwn(ranks, nextState)) throw ledgerError('poller_state_invalid');
      const existing = state.poller[triggerId];
      if (!existing) {
        if (nextState !== 'observed') throw ledgerError('poller_transition_invalid');
      } else if (ranks[nextState] <= ranks[existing.state] || ranks[existing.state] === 6) {
        throw ledgerError('poller_transition_invalid');
      }
      state.poller[triggerId] = {
        ...(existing ?? {}),
        ...clone(evidence),
        state: nextState,
        updatedAtMs: this.now(),
      };
      return clone(state.poller[triggerId]);
    });
  }

  recordDeployment(triggerId, nextState, details = {}) {
    const allowed = {
      deploy_observed: ['deploy_intent'],
      deploy_intent: ['runtime_present', 'failed', 'rollback_intent', 'quarantined'],
      runtime_present: ['health_verified', 'rollback_intent', 'quarantined'],
      health_verified: ['deploy_succeeded', 'rollback_intent', 'quarantined'],
      rollback_intent: ['rollback_verified', 'quarantined'],
      rollback_verified: ['failed'],
      deploy_succeeded: [],
      failed: [],
      quarantined: [],
    };
    return this.mutate('deployment_transition', { triggerId, nextState }, (state) => {
      if (!Object.hasOwn(allowed, nextState)) throw ledgerError('deployment_state_invalid');
      const existing = state.deployments[triggerId];
      if (!existing) {
        if (nextState !== 'deploy_observed') throw ledgerError('deployment_transition_invalid');
      } else if (!allowed[existing.state]?.includes(nextState)) {
        throw ledgerError('deployment_transition_invalid');
      }
      state.deployments[triggerId] = {
        ...(existing ?? {}),
        ...clone(details),
        state: nextState,
        updatedAtMs: this.now(),
      };
      return clone(state.deployments[triggerId]);
    });
  }

  getState() {
    return this.load();
  }
}

export const ledgerInternals = {
  canonical,
  digest,
  initialState,
  WINDOW_MS,
  REQUEST_LIMIT,
};
