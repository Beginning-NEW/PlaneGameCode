#!/usr/bin/env node
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DeliveryStore,
  FileSecretProvider,
  JenkinsApiTokenProvider,
  WebhookAdmission,
} from './webhook-admission.mjs';
import { directLoopbackFetch } from './lib/direct-loopback-http.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const JOB_PATH = '/job/plane-game/job/main-cd';
const JENKINS_ORIGIN = 'http://127.0.0.1:18080';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
}

function parametersFrom(actions) {
  return (actions ?? []).flatMap((action) => action?.parameters ?? []);
}

function hasCandidateIdentity(actions, record) {
  const expected = new Map([
    ['TRIGGER_SOURCE', 'webhook'],
    ['GITHUB_SHA', record.candidate_sha],
    ['GITHUB_RUN_ID', record.run_id],
    ['GITHUB_RUN_ATTEMPT', record.run_attempt],
    ['TRIGGER_ID', `webhook:${record.delivery_id}`],
    ['WEBHOOK_DELIVERY_UUID', record.delivery_id],
  ]);
  const parameters = parametersFrom(actions);
  return [...expected].every(([name, value]) => {
    const matches = parameters.filter((parameter) => parameter?.name === name);
    return matches.length === 1 && String(matches[0].value ?? '') === value;
  });
}

function uniqueMatch(items, predicate, multipleCode) {
  const matches = (items ?? []).filter(predicate);
  if (matches.length > 1) {
    throw Object.assign(new Error('multiple Jenkins identity matches'), { code: multipleCode });
  }
  return matches[0] ?? null;
}

export class JenkinsEnqueuer {
  constructor({ baseUrl, user, tokenProvider, fetchImpl = directLoopbackFetch }) {
    const parsed = new URL(baseUrl);
    if (parsed.origin !== JENKINS_ORIGIN || parsed.username || parsed.password ||
        parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
      throw new Error('JENKINS_URL must be the fixed loopback Jenkins origin');
    }
    this.baseUrl = parsed.origin;
    this.user = user;
    this.tokenProvider = tokenProvider;
    this.fetchImpl = fetchImpl;
  }

  authorization() {
    const token = this.tokenProvider.get().toString('utf8').trim();
    if (!token) throw Object.assign(new Error('empty Jenkins token'), { code: 'credential_unavailable' });
    return `Basic ${Buffer.from(`${this.user}:${token}`).toString('base64')}`;
  }

  async request(path, options = {}) {
    const result = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...options,
      headers: { ...options.headers, authorization: this.authorization() },
      signal: AbortSignal.timeout(10_000),
    });
    return result;
  }

  normalizeQueueIdentity(location) {
    let parsed;
    try {
      parsed = new URL(location, `${this.baseUrl}/`);
    } catch {
      throw Object.assign(new Error('invalid Jenkins queue location'), { code: 'invalid_queue_location' });
    }
    const match = /^\/queue\/item\/([1-9][0-9]*)\/?$/.exec(parsed.pathname);
    if (parsed.origin !== this.baseUrl || parsed.username || parsed.password ||
        parsed.search || parsed.hash || !match) {
      throw Object.assign(new Error('invalid Jenkins queue location'), { code: 'invalid_queue_location' });
    }
    return { queueId: match[1], queueUrl: `${this.baseUrl}/queue/item/${match[1]}/` };
  }

  normalizeBuildIdentity(number, location) {
    const buildNumber = String(number ?? '');
    if (!/^[1-9][0-9]*$/.test(buildNumber)) {
      throw Object.assign(new Error('invalid Jenkins build identity'), { code: 'reconcile_failed' });
    }
    const expected = `${JOB_PATH}/${buildNumber}/`;
    const parsed = new URL(location ?? expected, `${this.baseUrl}/`);
    if (parsed.origin !== this.baseUrl || parsed.pathname !== expected ||
        parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw Object.assign(new Error('invalid Jenkins build identity'), { code: 'reconcile_failed' });
    }
    return { buildNumber, buildUrl: `${this.baseUrl}${expected}` };
  }

  isExpectedJobUrl(value) {
    try {
      const parsed = new URL(value, `${this.baseUrl}/`);
      return parsed.origin === this.baseUrl && parsed.pathname === `${JOB_PATH}/` &&
        !parsed.search && !parsed.hash && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }

  buildObservation(build, queue = {}) {
    const identity = this.normalizeBuildIdentity(build?.number, build?.url);
    return {
      ...queue,
      ...identity,
      state: build?.building || build?.result == null ? 'running' : 'completed',
      buildResult: build?.result ?? null,
    };
  }

  async reconcile(record) {
    if (record.queue_id) {
      const itemResponse = await this.request(
        `/queue/item/${record.queue_id}/api/json?tree=id,url,cancelled,task[url],executable[number,url],actions[parameters[name,value]]]`,
      );
      if (itemResponse.ok) {
        const item = await itemResponse.json();
        if (!this.isExpectedJobUrl(item?.task?.url) || !hasCandidateIdentity(item?.actions, record)) {
          throw Object.assign(new Error('queue candidate identity mismatch'), {
            code: 'queue_candidate_mismatch',
          });
        }
        const queue = this.normalizeQueueIdentity(item.url ?? record.queue_url);
        if (queue.queueId !== record.queue_id ||
            (item?.id != null && String(item.id) !== record.queue_id)) {
          throw Object.assign(new Error('queue identity mismatch'), { code: 'queue_identity_mismatch' });
        }
        if (item.cancelled) return { ...queue, state: 'completed', buildResult: 'CANCELLED' };
        if (item.executable) return this.buildObservation(item.executable, queue);
        return { ...queue, state: 'queued' };
      }
      if (itemResponse.status !== 404) {
        throw Object.assign(new Error('queue item reconciliation failed'), { code: 'reconcile_failed' });
      }
    }

    const queue = await this.request(
      '/queue/api/json?tree=items[id,url,task[url],actions[parameters[name,value]]]',
    );
    if (!queue.ok) throw Object.assign(new Error('queue reconciliation failed'), { code: 'reconcile_failed' });
    const queuePayload = await queue.json();
    const queued = uniqueMatch(
      queuePayload.items,
      (item) => this.isExpectedJobUrl(item?.task?.url) &&
        hasCandidateIdentity(item.actions, record),
      'queue_multiple_matches',
    );
    if (queued) {
      const identity = this.normalizeQueueIdentity(queued.url ?? `/queue/item/${queued.id}/`);
      if (record.queue_id && identity.queueId !== record.queue_id) {
        throw Object.assign(new Error('queue identity mismatch'), { code: 'queue_identity_mismatch' });
      }
      return { ...identity, state: 'queued' };
    }

    const builds = await this.request(
      `${JOB_PATH}/api/json?tree=builds[number,url,building,result,actions[parameters[name,value]]]`,
    );
    if (!builds.ok) throw Object.assign(new Error('build reconciliation failed'), { code: 'reconcile_failed' });
    const buildPayload = await builds.json();
    const build = uniqueMatch(
      buildPayload.builds,
      (item) => hasCandidateIdentity(item.actions, record),
      'build_multiple_matches',
    );
    const observation = build ? this.buildObservation(build, {
      queueId: record.queue_id ?? null,
      queueUrl: record.queue_id ? record.queue_url : null,
    }) : null;
    if (record.build_number && observation?.buildNumber !== record.build_number) {
      throw Object.assign(new Error('build identity mismatch'), { code: 'build_identity_mismatch' });
    }
    return observation;
  }

  async enqueue(candidate) {
    const query = new URLSearchParams({
      TRIGGER_SOURCE: 'webhook',
      GITHUB_SHA: candidate.candidateSha,
      GITHUB_RUN_ID: candidate.runId,
      GITHUB_RUN_ATTEMPT: candidate.runAttempt,
      TRIGGER_ID: `webhook:${candidate.deliveryId}`,
      WEBHOOK_DELIVERY_UUID: candidate.deliveryId,
    });
    const result = await this.request(`${JOB_PATH}/buildWithParameters?${query}`, { method: 'POST' });
    const location = result.headers.get('location');
    if (result.status !== 201 || !location) {
      throw Object.assign(new Error('Jenkins did not confirm queue creation'), { code: 'jenkins_rejected' });
    }
    return this.normalizeQueueIdentity(location);
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request too large'), { code: 'body_too_large' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(`${JSON.stringify(body)}\n`);
}

export function createGateway({ admission }) {
  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      send(response, 200, { status: 'ok' });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/github/workflow-run') {
      send(response, 404, { code: 'not_found' });
      return;
    }
    let rawBody;
    try {
      rawBody = await readBody(request);
    } catch (error) {
      send(response, error?.code === 'body_too_large' ? 413 : 400, { code: 'invalid_request' });
      return;
    }
    const result = await admission.handle({
      rawBody,
      signature: request.headers['x-hub-signature-256'],
      deliveryId: request.headers['x-github-delivery'],
      event: request.headers['x-github-event'],
    });
    send(response, result.status, result.body);
  });
}

function main() {
  if (process.env.CD_TRIGGER_MODE !== 'webhook') throw new Error('Webhook trigger mode is not exclusively enabled');
  const store = new DeliveryStore(required('WEBHOOK_STATE_DB'));
  const admission = new WebhookAdmission({
    webhookSecretProvider: new FileSecretProvider(required('WEBHOOK_SECRET_FILE')),
    store,
    enqueuer: new JenkinsEnqueuer({
      baseUrl: required('JENKINS_URL'),
      user: required('JENKINS_USER'),
      tokenProvider: new JenkinsApiTokenProvider(required('JENKINS_API_TOKEN_FILE')),
    }),
    logger: ({ outcome, code }) => console.info(`webhook_admission outcome=${outcome} code=${code}`),
  });
  const server = createGateway({ admission });
  const host = process.env.WEBHOOK_LISTEN_HOST ?? '127.0.0.1';
  const port = Number(process.env.WEBHOOK_LISTEN_PORT ?? '9080');
  server.listen(port, host, () => console.info(`webhook_gateway listening=${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => {
      store.close();
      process.exit(0);
    }));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
