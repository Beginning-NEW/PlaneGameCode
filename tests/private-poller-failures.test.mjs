import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PublicGitHubClient } from '../ops/jenkins/lib/github-public-client.mjs';
import { JenkinsCredentialProvider, JenkinsPollerClient } from '../ops/jenkins/lib/jenkins-poller-client.mjs';
import { SecureLedger } from '../ops/jenkins/lib/secure-ledger.mjs';

const NOW = Date.parse('2026-11-09T00:00:00Z');
const DISCOVERY = '/repos/Beginning-NEW/PlaneGameCode/actions/workflows/checks.yml/runs?branch=main&event=push&status=completed&per_page=100';
const candidate = {
  sha: '8'.repeat(40),
  runId: '42498440964',
  runAttempt: '1',
  triggerId: `${'8'.repeat(40)}:42498440964:1`,
};

async function fixture(t, now = () => NOW) {
  const parent = await mkdtemp(join(tmpdir(), 'plane-poller-failure-'));
  const root = join(parent, 'state');
  SecureLedger.initialize(root);
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, root, ledger: new SecureLedger(root, { now }) };
}

function rateHeaders(extra = {}) {
  return {
    'content-type': 'application/json',
    'x-ratelimit-limit': '60',
    'x-ratelimit-remaining': '58',
    'x-ratelimit-reset': String(Math.floor((NOW + 3600000) / 1000)),
    ...extra,
  };
}

test('missing rate headers, 429 Retry-After, redirects, and pagination all fail closed', async (t) => {
  for (const [response, code] of [
    [new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }), 'rate_headers_missing'],
    [new Response('{}', { status: 429, headers: rateHeaders({ 'retry-after': '120' }) }), 'github_rate_limited'],
    [new Response('', { status: 302, headers: rateHeaders({ location: 'https://example.test/' }) }), 'github_redirect_rejected'],
    [new Response('[]', { status: 200, headers: rateHeaders({ link: '<https://api.github.com/next>; rel="next"' }) }), 'github_pagination_rejected'],
  ]) {
    const { ledger } = await fixture(t);
    const client = new PublicGitHubClient({ ledger, fetchImpl: async () => response, now: () => NOW });
    await assert.rejects(client.get(DISCOVERY, { list: true }), { code });
    assert.ok(ledger.getState().clock.backoffUntilMs >= (code === 'github_pagination_rejected' ? 0 : NOW));
  }
});

test('GitHub 5xx, timeout, malformed JSON, content type, and oversized responses fail closed', async (t) => {
  for (const [response, code] of [
    [new Response('{}', { status: 500, headers: rateHeaders() }), 'github_http_rejected'],
    [new Response('{', { status: 200, headers: rateHeaders() }), 'github_json_malformed'],
    [new Response('{}', { status: 200, headers: rateHeaders({ 'content-type': 'text/html' }) }), 'github_content_type_rejected'],
    [new Response('{}', { status: 200, headers: rateHeaders({ 'content-length': String(1024 * 1024 + 1) }) }), 'github_response_too_large'],
  ]) {
    const { ledger } = await fixture(t);
    const client = new PublicGitHubClient({ ledger, fetchImpl: async () => response, now: () => NOW });
    await assert.rejects(client.get(DISCOVERY), { code });
    assert.equal(ledger.getState().budget.requests.length, 1);
  }

  const { ledger } = await fixture(t);
  const timeoutClient = new PublicGitHubClient({
    ledger,
    fetchImpl: async () => { throw new DOMException('timed out', 'TimeoutError'); },
    now: () => NOW,
  });
  await assert.rejects(timeoutClient.get(DISCOVERY), { code: 'github_transport_failure' });
  assert.ok(ledger.getState().clock.backoffUntilMs >= NOW + 60 * 60 * 1000);
});

test('fixed GitHub origin/path/query controls reject SSRF before a request is sent', async (t) => {
  const { ledger } = await fixture(t);
  let requests = 0;
  const client = new PublicGitHubClient({ ledger, fetchImpl: async () => { requests += 1; } });
  for (const url of [
    'http://api.github.com/repos/Beginning-NEW/PlaneGameCode/git/ref/heads/main',
    'https://example.test/repos/Beginning-NEW/PlaneGameCode/git/ref/heads/main',
    '/repos/Beginning-NEW/other/git/ref/heads/main',
    `${DISCOVERY}&page=2`,
  ]) {
    await assert.rejects(client.get(url), { code: /github_(url|path|query)_forbidden/ });
  }
  assert.equal(requests, 0);
  assert.equal(ledger.getState().budget.requests.length, 0);
});

test('clock regression and unknown/uninitialized restart state never authorize a request', async (t) => {
  let now = NOW;
  const { parent, root, ledger } = await fixture(t, () => now);
  ledger.recordRequest();
  now -= 1;
  assert.throws(() => ledger.recordRequest(), { code: 'clock_regression' });
  assert.throws(() => new SecureLedger(join(parent, 'missing'), { now: () => NOW }));
  assert.equal(new SecureLedger(root, { now: () => NOW }).getState().budget.requests.length, 1);
});

test('Jenkins Basic auth exists only in the request header and credentials remain file-backed', async (t) => {
  const { parent } = await fixture(t);
  const directory = join(parent, 'credentials');
  const path = join(directory, 'jenkins-poller-api-token');
  await mkdir(directory, { mode: 0o700 });
  await writeFile(path, JSON.stringify({
    version: 1,
    username: 'plane-actions-poller',
    token: 'T'.repeat(32),
    uuid: '11111111-1111-4111-8111-111111111111',
  }), { mode: 0o600 });
  await chmod(directory, 0o700);
  await chmod(path, 0o600);
  const seen = [];
  const client = new JenkinsPollerClient({
    credentialProvider: new JenkinsCredentialProvider(path),
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), options });
      return new Response(null, {
        status: 201,
        headers: { 'x-jenkins': '2.580.2', 'x-hudson': '1.395', location: '/queue/item/9/' },
      });
    },
  });
  await client.enqueue(candidate);
  assert.equal(seen.length, 1);
  assert.doesNotMatch(seen[0].url, /plane-actions-poller|T{16}/);
  assert.ok(!Object.values(process.env).some((value) => String(value).includes('T'.repeat(32))));
  assert.match(seen[0].options.headers.authorization, /^Basic /);
  assert.equal(seen[0].options.redirect, 'manual');
});

test('Jenkins credentials reject writable or symlinked ancestor components before use', { skip: process.platform === 'win32' }, async (t) => {
  const { parent } = await fixture(t);
  const unsafe = join(parent, 'unsafe');
  const credentials = join(unsafe, 'credentials');
  await mkdir(credentials, { recursive: true, mode: 0o700 });
  await chmod(unsafe, 0o770);
  const token = join(credentials, 'jenkins-api-token');
  await writeFile(token, JSON.stringify({
    version: 1,
    username: 'plane-actions-poller',
    token: 'X'.repeat(32),
    uuid: '22222222-2222-4222-8222-222222222222',
  }), { mode: 0o600 });
  assert.throws(() => new JenkinsCredentialProvider(token).get(), { code: 'credential_unavailable' });

  await chmod(unsafe, 0o700);
  const linkedParent = join(parent, 'linked-parent');
  await symlink(credentials, linkedParent, 'dir');
  const linkedToken = join(linkedParent, 'jenkins-api-token');
  assert.throws(() => new JenkinsCredentialProvider(linkedToken).get(), { code: 'credential_unavailable' });
});

for (const [name, response, code] of [
  ['permission denial', new Response('denied', { status: 403, headers: { 'x-jenkins': '2', 'x-hudson': '1', 'content-type': 'text/plain' } }), 'jenkins_rejected'],
  ['missing Jenkins identity', new Response('', { status: 201, headers: { location: '/login' } }), 'jenkins_identity_missing'],
  ['malformed Jenkins version identity', new Response('', { status: 201, headers: { 'x-jenkins': 'not-a-version', location: '/login' } }), 'jenkins_identity_missing'],
  ['non-loopback Location', new Response('', { status: 201, headers: { 'x-jenkins': '2', 'x-hudson': '1', location: 'http://example.test/queue/item/1/' } }), 'jenkins_queue_location_invalid'],
  ['malformed Location', new Response('', { status: 201, headers: { 'x-jenkins': '2', 'x-hudson': '1', location: '/queue/not-an-item/' } }), 'jenkins_queue_location_invalid'],
  ['unexpected body type', new Response('{}', { status: 201, headers: { 'x-jenkins': '2', 'x-hudson': '1', location: '/queue/item/1/', 'content-type': 'application/json' } }), 'jenkins_content_type_rejected'],
  ['server failure', new Response('', { status: 500, headers: { 'x-jenkins': '2', 'x-hudson': '1' } }), 'jenkins_rejected'],
]) {
  test(`Jenkins ${name} fails closed`, async () => {
    const client = new JenkinsPollerClient({
      credentialProvider: { get: () => ({ username: 'plane-actions-poller', token: 'U'.repeat(32) }) },
      fetchImpl: async () => response,
    });
    await assert.rejects(client.enqueue(candidate), { code });
  });
}

test('Jenkins success identity accepts X-Jenkins without the legacy X-Hudson header', async () => {
  const client = new JenkinsPollerClient({
    credentialProvider: { get: () => ({ username: 'plane-actions-poller', token: 'N'.repeat(32) }) },
    fetchImpl: async () => new Response('', {
      status: 201,
      headers: { 'x-jenkins': '2.580.2', location: '/queue/item/17/' },
    }),
  });
  assert.deepEqual(await client.enqueue(candidate), {
    queueId: '17',
    queueUrl: 'http://127.0.0.1:18080/queue/item/17/',
  });
});

test('Jenkins bare 201 queue creation is accepted as identity evidence', async () => {
  const client = new JenkinsPollerClient({
    credentialProvider: { get: () => ({ username: 'plane-actions-poller', token: 'N'.repeat(32) }) },
    fetchImpl: async () => new Response('', {
      status: 201,
      headers: { location: 'http://127.0.0.1:18080/queue/item/5/' },
    }),
  });
  assert.deepEqual(await client.enqueue(candidate), {
    queueId: '5',
    queueUrl: 'http://127.0.0.1:18080/queue/item/5/',
  });
});

test('Jenkins timeout is an ambiguous side effect and fails closed', async () => {
  const client = new JenkinsPollerClient({
    credentialProvider: { get: () => ({ username: 'plane-actions-poller', token: 'W'.repeat(32) }) },
    fetchImpl: async () => { throw new DOMException('timed out', 'TimeoutError'); },
  });
  await assert.rejects(client.enqueue(candidate), { code: 'jenkins_outcome_unknown' });
});

test('Jenkins response body secret echo is terminal and reconciliation requires exactly one tuple', async () => {
  const token = 'V'.repeat(32);
  const echoClient = new JenkinsPollerClient({
    credentialProvider: { get: () => ({ username: 'plane-actions-poller', token }) },
    fetchImpl: async () => new Response(token, {
      status: 201,
      headers: { 'x-jenkins': '2', 'x-hudson': '1', location: '/queue/item/1/', 'content-type': 'text/plain' },
    }),
  });
  await assert.rejects(echoClient.enqueue(candidate), { code: 'jenkins_secret_echo' });

  const actions = [{ parameters: [
    { name: 'TRIGGER_SOURCE', value: 'poller' },
    { name: 'GITHUB_SHA', value: candidate.sha },
    { name: 'GITHUB_RUN_ID', value: candidate.runId },
    { name: 'GITHUB_RUN_ATTEMPT', value: candidate.runAttempt },
    { name: 'TRIGGER_ID', value: candidate.triggerId },
    { name: 'WEBHOOK_DELIVERY_UUID', value: '' },
  ] }];
  const responses = [
    new Response(JSON.stringify({ items: [
      { id: 1, url: 'http://127.0.0.1:18080/queue/item/1/', task: { url: 'http://127.0.0.1:18080/job/plane-game/job/main-cd/' }, actions },
      { id: 2, url: 'http://127.0.0.1:18080/queue/item/2/', task: { url: 'http://127.0.0.1:18080/job/plane-game/job/main-cd/' }, actions },
    ] }), { status: 200, headers: { 'x-jenkins': '2', 'x-hudson': '1', 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ builds: [] }), { status: 200, headers: { 'x-jenkins': '2', 'x-hudson': '1', 'content-type': 'application/json' } }),
  ];
  const reconcileClient = new JenkinsPollerClient({
    credentialProvider: { get: () => ({ username: 'plane-actions-poller', token }) },
    fetchImpl: async () => responses.shift(),
  });
  await assert.rejects(reconcileClient.reconcile(candidate), { code: 'jenkins_reconcile_ambiguous' });

  const mixedActions = structuredClone(actions);
  mixedActions[0].parameters.push({ name: 'DEPLOY_PORT', value: '80' });
  const mixedResponses = [
    new Response(JSON.stringify({ items: [
      { id: 3, url: 'http://127.0.0.1:18080/queue/item/3/',
        task: { url: 'http://127.0.0.1:18080/job/plane-game/job/main-cd/' }, actions: mixedActions },
    ] }), { status: 200, headers: { 'x-jenkins': '2', 'x-hudson': '1', 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ builds: [] }), {
      status: 200, headers: { 'x-jenkins': '2', 'x-hudson': '1', 'content-type': 'application/json' },
    }),
  ];
  const mixedClient = new JenkinsPollerClient({
    credentialProvider: { get: () => ({ username: 'plane-actions-poller', token }) },
    fetchImpl: async () => mixedResponses.shift(),
  });
  await assert.rejects(mixedClient.reconcile(candidate), { code: 'jenkins_reconcile_ambiguous' });
});
