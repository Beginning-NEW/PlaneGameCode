import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateCandidate } from '../ops/jenkins/lib/github-candidate.mjs';
import { PublicGitHubClient } from '../ops/jenkins/lib/github-public-client.mjs';
import { JenkinsPollerClient } from '../ops/jenkins/lib/jenkins-poller-client.mjs';
import { SecureLedger } from '../ops/jenkins/lib/secure-ledger.mjs';
import { PrivateActionsPoller } from '../ops/jenkins/private-actions-poller.mjs';

const NOW = Date.parse('2026-11-09T00:00:00Z');
const SHA = '8'.repeat(40);
const RUN_ID = '42498440964';
const ATTEMPT = '1';
const TRIGGER_ID = `${SHA}:${RUN_ID}:${ATTEMPT}`;

async function ledgerFixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'plane-poller-'));
  const root = join(parent, 'state');
  SecureLedger.initialize(root);
  const ledger = new SecureLedger(root, { now: () => NOW });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { root, ledger };
}

function rateHeaders(remaining = 58, extra = {}) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'x-ratelimit-limit': '60',
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(Math.floor((NOW + 60 * 60 * 1000) / 1000)),
    ...extra,
  };
}

function jsonResponse(data, { status = 200, remaining = 58, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: rateHeaders(remaining, headers),
  });
}

function run(overrides = {}) {
  return {
    id: Number(RUN_ID),
    run_attempt: Number(ATTEMPT),
    run_number: 91,
    workflow_id: 407966338,
    name: 'Checks',
    path: '.github/workflows/checks.yml',
    event: 'push',
    head_branch: 'main',
    head_sha: SHA,
    status: 'completed',
    conclusion: 'success',
    run_started_at: '2026-11-08T23:50:00Z',
    updated_at: '2026-11-08T23:58:00Z',
    repository: { full_name: 'Beginning-NEW/PlaneGameCode' },
    head_repository: { full_name: 'Beginning-NEW/PlaneGameCode' },
    ...overrides,
  };
}

function approval(overrides = {}) {
  return {
    state: 'approved',
    submitted_at: '2026-11-08T23:55:00Z',
    user: { login: 'Beginning-NEW', id: 183624934 },
    environments: [{ name: 'production' }],
    ...overrides,
  };
}

function deployment(overrides = {}) {
  return { id: 7001, sha: SHA, environment: 'production', ...overrides };
}

function deploymentStatus(overrides = {}) {
  return {
    id: 8001,
    state: 'success',
    deployment_url: 'https://api.github.com/repos/Beginning-NEW/PlaneGameCode/deployments/7001',
    created_at: '2026-11-08T23:57:00Z',
    ...overrides,
  };
}

function validationResponses(overrides = {}) {
  return [
    jsonResponse(run(overrides.run)),
    jsonResponse(overrides.approvals ?? [approval()]),
    jsonResponse(overrides.deployments ?? [deployment()]),
    jsonResponse(overrides.statuses ?? [deploymentStatus()]),
    jsonResponse(overrides.main ?? { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA } }),
  ];
}

function sequenceFetch(responses, seen = []) {
  return async (url, options) => {
    seen.push({ url: String(url), options });
    const response = responses.shift();
    if (!response) throw new Error('unexpected request');
    return response;
  };
}

test('secure ledger persists a strict 16-call candidate reservation and one candidate per hour', async (t) => {
  const { root, ledger } = await ledgerFixture(t);
  ledger.recordRequest();
  ledger.admitCandidate(TRIGGER_ID, 46);
  for (let index = 0; index < 15; index += 1) ledger.recordRequest(TRIGGER_ID);
  const state = new SecureLedger(root, { now: () => NOW }).getState();
  assert.equal(state.budget.requests.length, 16);
  assert.equal(state.budget.reservations[TRIGGER_ID].remaining, 0);
  assert.throws(() => ledger.recordRequest(TRIGGER_ID), { code: 'request_reservation_exhausted' });
  assert.throws(() => ledger.admitCandidate(`${'9'.repeat(40)}:5:1`, 60), {
    code: 'candidate_hourly_limit',
  });
});

test('secure ledger detects journal truncation and recovers an fsynced journal ahead of snapshot', async (t) => {
  const { root, ledger } = await ledgerFixture(t);
  const oldSnapshot = await readFile(join(root, 'snapshot.json'));
  ledger.recordRequest();
  await writeFile(join(root, 'snapshot.json'), oldSnapshot);
  assert.equal(new SecureLedger(root, { now: () => NOW }).getState().budget.requests.length, 1);
  const journal = await readFile(join(root, 'journal.ndjson'));
  await writeFile(join(root, 'journal.ndjson'), journal.subarray(0, journal.length - 2));
  assert.throws(() => new SecureLedger(root, { now: () => NOW }), { code: 'journal_truncated' });
});

test('secure ledger rejects symlink replacement and a different service UID', { skip: process.platform === 'win32' }, async (t) => {
  const first = await ledgerFixture(t);
  assert.throws(() => new SecureLedger(first.root, { uid: process.getuid() + 1, now: () => NOW }), {
    code: 'ledger_directory_unsafe',
  });

  const parent = await mkdtemp(join(tmpdir(), 'plane-poller-symlink-'));
  const root = join(parent, 'state');
  SecureLedger.initialize(root);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const snapshot = join(root, 'snapshot.json');
  const outside = join(parent, 'outside');
  await writeFile(outside, '{}\n', { mode: 0o600 });
  await unlink(snapshot);
  await symlink(outside, snapshot, 'file');
  assert.throws(() => new SecureLedger(root, { now: () => NOW }), {
    code: /ledger_(file_unsafe|not_initialized)/,
  });
});

test('persistent shared flock admits exactly one ledger writer', { skip: process.platform === 'win32' }, async (t) => {
  const { root } = await ledgerFixture(t);
  const lock = join(root, '.shared.lock');
  const holder = spawn('flock', [
    '--no-fork', '--nonblock', lock, process.execPath, '-e',
    'process.stdout.write("locked\\n"); setTimeout(() => {}, 10000)',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => holder.kill('SIGTERM'));
  const [ready] = await once(holder.stdout, 'data');
  assert.equal(String(ready), 'locked\n');

  const contender = spawnSync('flock', [
    '--no-fork', '--nonblock', lock, process.execPath, '-e', 'process.exit(0)',
  ], { encoding: 'utf8' });
  assert.notEqual(contender.status, 0);

  holder.kill('SIGTERM');
  await once(holder, 'exit');
});

test('candidate validation accepts the reviewed test-only self-approval inside the exact attempt window', async (t) => {
  const { ledger } = await ledgerFixture(t);
  ledger.recordRequest();
  ledger.admitCandidate(TRIGGER_ID, 58);
  const seen = [];
  const client = new PublicGitHubClient({
    ledger,
    reservationId: TRIGGER_ID,
    fetchImpl: sequenceFetch(validationResponses(), seen),
    now: () => NOW,
  });
  const evidence = await validateCandidate(client, { sha: SHA, runId: RUN_ID, runAttempt: ATTEMPT });
  assert.equal(evidence.approvals[0].reviewer.login, 'Beginning-NEW');
  assert.equal(evidence.approvals[0].reviewer.id, 183624934);
  assert.equal(evidence.approvals[0].environment, 'production');
  assert.equal(evidence.deployment.status.state, 'success');
  assert.equal(seen.length, 5);
  assert.ok(seen.every(({ options }) => options.redirect === 'manual'));
});

test('approval from attempt 1 cannot authorize attempt 2', async (t) => {
  const { ledger } = await ledgerFixture(t);
  const trigger = `${SHA}:${RUN_ID}:2`;
  ledger.recordRequest();
  ledger.admitCandidate(trigger, 58);
  const responses = validationResponses({
    run: {
      run_attempt: 2,
      run_started_at: '2026-11-08T23:56:00Z',
      updated_at: '2026-11-08T23:59:00Z',
    },
    approvals: [approval({ submitted_at: '2026-11-08T23:55:00Z' })],
  });
  const client = new PublicGitHubClient({
    ledger,
    reservationId: trigger,
    fetchImpl: sequenceFetch(responses),
    now: () => NOW,
  });
  await assert.rejects(
    validateCandidate(client, { sha: SHA, runId: RUN_ID, runAttempt: '2' }),
    { code: 'approval_attempt_ambiguous' },
  );
});

for (const [name, overrides, code] of [
  ['empty approvals', { approvals: [] }, 'approval_history_rejected'],
  ['unapproved reviewer', { approvals: [approval({ user: { login: 'other', id: 2 } })] }, 'approval_reviewer_rejected'],
  ['bypassed approval', { approvals: [approval({ state: 'bypassed' })] }, 'approval_state_rejected'],
  ['rejected approval', { approvals: [approval({ state: 'rejected' })] }, 'approval_state_rejected'],
  ['unknown approval state', { approvals: [approval({ state: 'pending' })] }, 'approval_state_rejected'],
  ['skipped publish run', { run: { conclusion: 'skipped' } }, 'run_evidence_rejected'],
  ['workflow dispatch', { run: { event: 'workflow_dispatch' } }, 'run_evidence_rejected'],
  ['wrong workflow id', { run: { workflow_id: 7 } }, 'run_evidence_rejected'],
  ['wrong workflow path', { run: { path: '.github/workflows/release.yml' } }, 'run_evidence_rejected'],
  ['foreign repository', { run: { repository: { full_name: 'other/PlaneGameCode' } } }, 'run_evidence_rejected'],
  ['fork head repository', { run: { head_repository: { full_name: 'fork/PlaneGameCode' } } }, 'run_evidence_rejected'],
  ['wrong SHA', { run: { head_sha: '7'.repeat(40) } }, 'run_evidence_rejected'],
  ['deployment SHA mismatch', { deployments: [deployment({ sha: '7'.repeat(40) })] }, 'deployment_ambiguous'],
  ['failed deployment status', { statuses: [deploymentStatus({ state: 'failure' })] }, 'deployment_status_rejected'],
  ['moved main', { main: { ref: 'refs/heads/main', object: { type: 'commit', sha: '7'.repeat(40) } } }, 'main_moved'],
]) {
  test(`candidate validation rejects ${name}`, async (t) => {
    const { ledger } = await ledgerFixture(t);
    ledger.recordRequest();
    ledger.admitCandidate(TRIGGER_ID, 58);
    const client = new PublicGitHubClient({
      ledger,
      reservationId: TRIGGER_ID,
      fetchImpl: sequenceFetch(validationResponses(overrides)),
      now: () => NOW,
    });
    await assert.rejects(validateCandidate(client, { sha: SHA, runId: RUN_ID, runAttempt: ATTEMPT }), { code });
  });
}

test('positive poll cycle performs one discovery, two fresh five-call validations, and one Jenkins POST', async (t) => {
  const { ledger } = await ledgerFixture(t);
  const discovery = jsonResponse({ workflow_runs: [run()] }, {
    remaining: 58,
    headers: { etag: '"candidate-v1"' },
  });
  const githubSeen = [];
  const githubClient = new PublicGitHubClient({
    ledger,
    fetchImpl: sequenceFetch([
      discovery,
      ...validationResponses(),
      ...validationResponses(),
    ], githubSeen),
    now: () => NOW,
  });
  const jenkinsSeen = [];
  const jenkinsClient = new JenkinsPollerClient({
    credentialProvider: { get: () => ({ username: 'plane-actions-poller', token: 'A'.repeat(32) }) },
    fetchImpl: async (url, options) => {
      jenkinsSeen.push({ url: String(url), options });
      return new Response(null, {
        status: 201,
        headers: {
          'x-jenkins': '2.580.2',
          'x-hudson': '1.395',
          location: '/queue/item/17/',
        },
      });
    },
  });
  const result = await new PrivateActionsPoller({ ledger, githubClient, jenkinsClient }).runOnce();
  assert.equal(result.outcome, 'queued');
  assert.equal(githubSeen.length, 11);
  assert.equal(jenkinsSeen.length, 1);
  assert.match(jenkinsSeen[0].url, /TRIGGER_SOURCE=poller/);
  assert.match(jenkinsSeen[0].url, new RegExp(`TRIGGER_ID=${encodeURIComponent(TRIGGER_ID)}`));
  assert.equal(ledger.getState().poller[TRIGGER_ID].state, 'queued');
  assert.equal(ledger.getState().budget.reservations[TRIGGER_ID].remaining, 5);
});

test('Jenkins redirects and ambiguous POST outcomes quarantine without a second POST', async (t) => {
  const { ledger } = await ledgerFixture(t);
  const githubClient = new PublicGitHubClient({
    ledger,
    fetchImpl: sequenceFetch([
      jsonResponse({ workflow_runs: [run()] }, { remaining: 58, headers: { etag: '"candidate-v1"' } }),
      ...validationResponses(),
      ...validationResponses(),
    ]),
    now: () => NOW,
  });
  let posts = 0;
  const jenkinsClient = new JenkinsPollerClient({
    credentialProvider: { get: () => ({ username: 'plane-actions-poller', token: 'B'.repeat(32) }) },
    fetchImpl: async () => {
      posts += 1;
      return new Response('', {
        status: 302,
        headers: { 'x-jenkins': '2.580.2', 'x-hudson': '1.395', location: 'http://example.test/' },
      });
    },
  });
  await assert.rejects(new PrivateActionsPoller({ ledger, githubClient, jenkinsClient }).runOnce(), {
    code: 'jenkins_redirect_rejected',
  });
  assert.equal(posts, 1);
  assert.equal(ledger.getState().poller[TRIGGER_ID].state, 'quarantined');
});
