import { Buffer } from 'node:buffer';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { directLoopbackFetch } from './direct-loopback-http.mjs';

const JENKINS_ORIGIN = 'http://127.0.0.1:18080';
const JOB_PATH = '/job/plane-game/job/main-cd';
const MAX_BODY_BYTES = 64 * 1024;

function jenkinsError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function assertSafeCredentialPath(path, uid) {
  if (!isAbsolute(path) || resolve(path) !== path) throw jenkinsError('credential_unavailable');
  let directory = dirname(path);
  let immediateParent = true;
  while (true) {
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw jenkinsError('credential_unavailable');
    if (process.platform !== 'win32') {
      if (immediateParent && (metadata.uid !== uid || (metadata.mode & 0o777) !== 0o700)) {
        throw jenkinsError('credential_unavailable');
      }
      const rootOwnedSticky = metadata.uid === 0 && (metadata.mode & 0o1000) !== 0;
      if (!immediateParent && ((metadata.uid !== uid && metadata.uid !== 0) ||
          ((metadata.mode & 0o022) !== 0 && !rootOwnedSticky))) {
        throw jenkinsError('credential_unavailable');
      }
    }
    const ancestor = dirname(directory);
    if (ancestor === directory) break;
    directory = ancestor;
    immediateParent = false;
  }
}

export class JenkinsCredentialProvider {
  constructor(path, { uid = process.getuid?.() ?? 0 } = {}) {
    this.path = path;
    this.uid = uid;
  }

  get() {
    if (!Number.isInteger(this.uid)) throw jenkinsError('credential_unavailable');
    let fd;
    try {
      assertSafeCredentialPath(this.path, this.uid);
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const metadata = fstatSync(fd);
      const permissionsInvalid = process.platform !== 'win32' &&
        (metadata.uid !== this.uid || (metadata.mode & 0o777) !== 0o600);
      if (!metadata.isFile() || metadata.nlink !== 1 || permissionsInvalid || metadata.size > 4096) {
        throw jenkinsError('credential_unavailable');
      }
      const value = JSON.parse(readFileSync(fd, 'utf8'));
      if (value?.version !== 1 || Object.keys(value).sort().join(',') !== 'token,username,uuid,version' ||
          value.username !== 'plane-actions-poller' || !/^[0-9A-Za-z]{16,256}$/.test(value.token ?? '') ||
          !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
            value.uuid ?? '')) {
        throw jenkinsError('credential_unavailable');
      }
      return { username: value.username, token: value.token };
    } catch (error) {
      if (error?.code === 'credential_unavailable') throw error;
      throw jenkinsError('credential_unavailable');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

async function boundedText(response) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw jenkinsError('jenkins_response_too_large');
  }
  if (!response.body) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw jenkinsError('jenkins_response_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function queueIdentity(location) {
  let url;
  try {
    url = new URL(location, `${JENKINS_ORIGIN}/`);
  } catch {
    throw jenkinsError('jenkins_queue_location_invalid');
  }
  const match = /^\/queue\/item\/([1-9][0-9]*)\/$/.exec(url.pathname);
  if (url.origin !== JENKINS_ORIGIN || url.username || url.password || url.search || url.hash || !match) {
    throw jenkinsError('jenkins_queue_location_invalid');
  }
  return { queueId: match[1], queueUrl: `${JENKINS_ORIGIN}/queue/item/${match[1]}/` };
}

function parameters(actions) {
  return (actions ?? []).flatMap((action) => action?.parameters ?? []);
}

function matchesTrigger(actions, candidate) {
  const expected = new Map([
    ['TRIGGER_SOURCE', 'poller'],
    ['GITHUB_SHA', candidate.sha],
    ['GITHUB_RUN_ID', candidate.runId],
    ['GITHUB_RUN_ATTEMPT', candidate.runAttempt],
    ['TRIGGER_ID', candidate.triggerId],
    ['WEBHOOK_DELIVERY_UUID', ''],
  ]);
  const actual = parameters(actions);
  return actual.length === expected.size && [...expected].every(([name, value]) => {
    const matches = actual.filter((entry) => entry?.name === name);
    return matches.length === 1 && String(matches[0].value ?? '') === value;
  });
}

export class JenkinsPollerClient {
  constructor({ credentialProvider, fetchImpl = directLoopbackFetch }) {
    this.credentialProvider = credentialProvider;
    this.fetchImpl = fetchImpl;
  }

  prepareAuthorization() {
    const credential = this.credentialProvider.get();
    return {
      authorization: `Basic ${Buffer.from(`${credential.username}:${credential.token}`).toString('base64')}`,
      token: credential.token,
    };
  }

  async request(path, { authorization, token, method = 'GET' } = {}) {
    if (!path.startsWith('/') || path.includes('..')) throw jenkinsError('jenkins_path_forbidden');
    let response;
    try {
      response = await this.fetchImpl(`${JENKINS_ORIGIN}${path}`, {
        method,
        headers: { authorization },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw jenkinsError('jenkins_outcome_unknown', error?.message);
    }
    if (response.status >= 300 && response.status < 400) throw jenkinsError('jenkins_redirect_rejected');
    // Jenkins 2.5xx only emits the legacy X-Hudson header on error pages, so the
    // authenticated success path proves its identity with X-Jenkins alone.
    const jenkinsVersion = response.headers.get('x-jenkins');
    if (!jenkinsVersion || !/^[0-9]+(?:[.][0-9]+)*$/.test(jenkinsVersion)) {
      throw jenkinsError('jenkins_identity_missing');
    }
    const body = await boundedText(response);
    if (token && body.includes(token)) throw jenkinsError('jenkins_secret_echo');
    return { response, body };
  }

  async enqueue(candidate, prepared = this.prepareAuthorization()) {
    const query = new URLSearchParams({
      TRIGGER_SOURCE: 'poller',
      GITHUB_SHA: candidate.sha,
      GITHUB_RUN_ID: candidate.runId,
      GITHUB_RUN_ATTEMPT: candidate.runAttempt,
      TRIGGER_ID: candidate.triggerId,
      WEBHOOK_DELIVERY_UUID: '',
    });
    const { response, body } = await this.request(`${JOB_PATH}/buildWithParameters?${query}`, {
      ...prepared,
      method: 'POST',
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (body.length > 0 && !/^(text\/html|text\/plain)(?:;|$)/i.test(contentType)) {
      throw jenkinsError('jenkins_content_type_rejected');
    }
    if (response.status !== 201) throw jenkinsError('jenkins_rejected');
    return queueIdentity(response.headers.get('location'));
  }

  async reconcile(candidate, prepared = this.prepareAuthorization()) {
    const queue = await this.request(
      '/queue/api/json?tree=items[id,url,task[url],actions[parameters[name,value]]]', prepared);
    if (queue.response.status !== 200 || !/^application\/json(?:;|$)/i.test(
      queue.response.headers.get('content-type') ?? '')) throw jenkinsError('jenkins_reconcile_failed');
    let queuePayload;
    try { queuePayload = JSON.parse(queue.body); } catch { throw jenkinsError('jenkins_reconcile_failed'); }
    if (!Array.isArray(queuePayload.items)) throw jenkinsError('jenkins_reconcile_failed');
    const queueMatches = queuePayload.items.filter((item) =>
      item?.task?.url === `${JENKINS_ORIGIN}${JOB_PATH}/` && matchesTrigger(item.actions, candidate));

    const builds = await this.request(
      `${JOB_PATH}/api/json?tree=builds[number,url,building,result,actions[parameters[name,value]]]`, prepared);
    if (builds.response.status !== 200 || !/^application\/json(?:;|$)/i.test(
      builds.response.headers.get('content-type') ?? '')) throw jenkinsError('jenkins_reconcile_failed');
    let buildPayload;
    try { buildPayload = JSON.parse(builds.body); } catch { throw jenkinsError('jenkins_reconcile_failed'); }
    if (!Array.isArray(buildPayload.builds)) throw jenkinsError('jenkins_reconcile_failed');
    const buildMatches = buildPayload.builds.filter((item) => matchesTrigger(item.actions, candidate));
    if (queueMatches.length + buildMatches.length !== 1) throw jenkinsError('jenkins_reconcile_ambiguous');
    if (queueMatches.length === 1) return { state: 'queued', ...queueIdentity(queueMatches[0].url) };
    const build = buildMatches[0];
    const number = String(build.number ?? '');
    if (!/^[1-9][0-9]*$/.test(number) || build.url !== `${JENKINS_ORIGIN}${JOB_PATH}/${number}/`) {
      throw jenkinsError('jenkins_build_identity_invalid');
    }
    return {
      state: build.building || build.result == null ? 'building' : 'completed',
      buildNumber: number,
      buildUrl: build.url,
      result: build.result ?? null,
    };
  }
}

export const jenkinsPollerPolicy = { JENKINS_ORIGIN, JOB_PATH };
