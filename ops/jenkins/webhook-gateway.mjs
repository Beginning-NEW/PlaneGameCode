#!/usr/bin/env node
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DeliveryStore,
  FileSecretProvider,
  WebhookAdmission,
} from './webhook-admission.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const JOB_PATH = '/job/plane-game/job/main-cd';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
}

function parametersFrom(actions) {
  return (actions ?? []).flatMap((action) => action?.parameters ?? []);
}

function hasDelivery(actions, deliveryId) {
  return parametersFrom(actions).some(
    (parameter) => parameter?.name === 'WEBHOOK_DELIVERY' && parameter?.value === deliveryId,
  );
}

export class JenkinsEnqueuer {
  constructor({ baseUrl, user, tokenProvider, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
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

  async reconcile(deliveryId) {
    const queue = await this.request(
      '/queue/api/json?tree=items[id,url,task[url],actions[parameters[name,value]]]',
    );
    if (!queue.ok) throw Object.assign(new Error('queue reconciliation failed'), { code: 'reconcile_failed' });
    const queuePayload = await queue.json();
    const queued = (queuePayload.items ?? []).find(
      (item) => item?.task?.url?.includes(`${JOB_PATH}/`) && hasDelivery(item.actions, deliveryId),
    );
    if (queued) return { queueUrl: queued.url ?? `${this.baseUrl}/queue/item/${queued.id}/` };

    const builds = await this.request(
      `${JOB_PATH}/api/json?tree=builds[number,url,actions[parameters[name,value]]]`,
    );
    if (!builds.ok) throw Object.assign(new Error('build reconciliation failed'), { code: 'reconcile_failed' });
    const buildPayload = await builds.json();
    const build = (buildPayload.builds ?? []).find((item) => hasDelivery(item.actions, deliveryId));
    return build ? { queueUrl: build.url } : null;
  }

  async enqueue(candidate) {
    const query = new URLSearchParams({
      CANDIDATE_SHA: candidate.candidateSha,
      ACTIONS_RUN_ID: candidate.runId,
      ACTIONS_RUN_ATTEMPT: candidate.runAttempt,
      WEBHOOK_DELIVERY: candidate.deliveryId,
    });
    const result = await this.request(`${JOB_PATH}/buildWithParameters?${query}`, { method: 'POST' });
    const queueUrl = result.headers.get('location');
    if (result.status !== 201 || !queueUrl) {
      throw Object.assign(new Error('Jenkins did not confirm queue creation'), { code: 'jenkins_rejected' });
    }
    return { queueUrl };
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
  const store = new DeliveryStore(required('WEBHOOK_STATE_DB'));
  const admission = new WebhookAdmission({
    webhookSecretProvider: new FileSecretProvider(required('WEBHOOK_SECRET_FILE')),
    store,
    enqueuer: new JenkinsEnqueuer({
      baseUrl: required('JENKINS_URL'),
      user: required('JENKINS_USER'),
      tokenProvider: new FileSecretProvider(required('JENKINS_API_TOKEN_FILE')),
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
