#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidatePolicy } from './lib/github-candidate.mjs';
import { SecureLedger } from './lib/secure-ledger.mjs';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IMAGE_REPOSITORY = 'ghcr.io/beginning-new/planegamecode';
const HEALTH_ORIGIN = 'http://127.0.0.1:18081';

function stateError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function parseRecord(path) {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw stateError('previous_good_unverifiable');
  }
  const entries = readFileSync(path, 'utf8').trim().split('\n').map((line) => line.split(/=(.*)/s, 2));
  if (entries.some(([key, value]) => !key || value == null)) throw stateError('previous_good_unverifiable');
  return Object.fromEntries(entries);
}

function docker(args) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST },
    }).trim();
  } catch {
    throw stateError('runtime_unverifiable');
  }
}

async function exactHealth(sha, fetchImpl = fetch) {
  try {
    const health = await fetchImpl(`${HEALTH_ORIGIN}/healthz`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    });
    if (health.status !== 200 || health.url && new URL(health.url).origin !== HEALTH_ORIGIN) return false;
    const version = await fetchImpl(`${HEALTH_ORIGIN}/version.json`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    });
    if (version.status !== 200 || version.url && new URL(version.url).origin !== HEALTH_ORIGIN) return false;
    return await version.text() === JSON.stringify({ sha });
  } catch {
    return false;
  }
}

export class DockerRuntimeInspector {
  constructor(runtimeRoot, { fetchImpl = fetch } = {}) {
    this.runtimeRoot = runtimeRoot;
    this.fetchImpl = fetchImpl;
  }

  previousGood() {
    const activePath = join(this.runtimeRoot, 'active_sha');
    if (!existsSync(activePath)) return null;
    if (lstatSync(activePath).isSymbolicLink() || !lstatSync(activePath).isFile()) {
      throw stateError('previous_good_unverifiable');
    }
    const sha = readFileSync(activePath, 'utf8').trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw stateError('previous_good_unverifiable');
    const record = parseRecord(join(this.runtimeRoot, 'releases', sha, 'release.env'));
    const candidate = candidatePolicy.exactCandidate({
      sha,
      runId: record.GITHUB_RUN_ID,
      runAttempt: record.GITHUB_RUN_ATTEMPT,
    });
    if (record.RELEASE_SHA !== sha || !DIGEST_PATTERN.test(record.IMAGE_DIGEST ?? '') ||
        record.TRIGGER_ID !== candidate.triggerId || record.RUNTIME_IDENTITY !== `plane-game-${sha}` ||
        record.HEALTH_STATUS !== 'healthy') throw stateError('previous_good_unverifiable');
    return { candidate, digest: record.IMAGE_DIGEST, runtimeIdentity: record.RUNTIME_IDENTITY };
  }

  async observeCandidate(candidate, digest) {
    let ids;
    try {
      ids = docker(['ps', '-aq', '--filter', `label=com.plane-game.trigger-id=${candidate.triggerId}`])
        .split(/\r?\n/).filter(Boolean);
    } catch {
      return { kind: 'unverifiable' };
    }
    if (ids.length === 0) return { kind: 'none' };
    if (ids.length !== 1) return { kind: 'multiple' };
    let inspected;
    try {
      inspected = JSON.parse(docker(['container', 'inspect', ids[0]]))[0];
    } catch {
      return { kind: 'unverifiable' };
    }
    const labels = inspected?.Config?.Labels ?? {};
    const exact = inspected?.Name === `/plane-game-${candidate.sha}` &&
      labels['com.plane-game.release-sha'] === candidate.sha &&
      labels['com.plane-game.image-digest'] === digest &&
      labels['com.plane-game.github-run-id'] === candidate.runId &&
      labels['com.plane-game.github-run-attempt'] === candidate.runAttempt &&
      labels['com.plane-game.trigger-id'] === candidate.triggerId;
    let digestExact = false;
    try {
      const repoDigests = docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', inspected.Image]);
      digestExact = JSON.parse(repoDigests).includes(`${IMAGE_REPOSITORY}@${digest}`);
    } catch {
      return { kind: 'unverifiable' };
    }
    const healthy = inspected?.State?.Running === true && inspected?.State?.Health?.Status === 'healthy' &&
      await exactHealth(candidate.sha, this.fetchImpl);
    return {
      kind: exact && digestExact && healthy ? 'healthy' : 'mismatch',
      runtimeIdentity: String(inspected?.Name ?? '').replace(/^\//, ''),
      containerId: ids[0],
      exact,
      digestExact,
      healthy,
    };
  }

  async previousIsExact(previous) {
    if (!previous) return false;
    const activePath = join(this.runtimeRoot, 'active_sha');
    if (!existsSync(activePath) || lstatSync(activePath).isSymbolicLink() ||
        readFileSync(activePath, 'utf8').trim() !== previous.candidate.sha) return false;
    const observation = await this.observeCandidate(previous.candidate, previous.digest);
    return observation.kind === 'healthy';
  }
}

export class DeploymentCoordinator {
  constructor({ ledger, inspector }) {
    this.ledger = ledger;
    this.inspector = inspector;
  }

  async begin(rawCandidate, digest) {
    const candidate = candidatePolicy.exactCandidate(rawCandidate);
    if (!DIGEST_PATTERN.test(digest)) throw stateError('digest_invalid');
    const current = this.ledger.getState().deployments[candidate.triggerId];
    if (current) return this.reconcile(candidate.triggerId);
    const poller = this.ledger.getState().poller[candidate.triggerId];
    if (poller?.state !== 'building') throw stateError('poller_not_building');
    const previousGood = this.inspector.previousGood();
    const details = {
      candidate,
      digest,
      runtimeIdentity: `plane-game-${candidate.sha}`,
      previousGood,
    };
    this.ledger.recordDeployment(candidate.triggerId, 'deploy_observed', details);
    this.ledger.recordDeployment(candidate.triggerId, 'deploy_intent', details);
    this.ledger.transitionPoller(candidate.triggerId, 'deploy_claimed', { digest });
    return { action: 'deploy', triggerId: candidate.triggerId };
  }

  async reconcile(triggerId) {
    const record = this.ledger.getState().deployments[triggerId];
    if (!record) throw stateError('deployment_missing');
    if (record.state === 'rollback_intent') return this.completeRollback(triggerId);
    if (['deploy_succeeded', 'failed', 'quarantined'].includes(record.state)) {
      return { action: 'terminal', state: record.state };
    }
    const observation = await this.inspector.observeCandidate(record.candidate, record.digest);
    if (observation.kind === 'healthy') {
      this.advanceSuccess(triggerId, observation);
      return { action: 'recovered_success' };
    }
    if (observation.kind === 'none') {
      if (record.previousGood && await this.inspector.previousIsExact(record.previousGood)) {
        this.ledger.recordDeployment(triggerId, 'failed', { failure: 'no_side_effect' });
        this.ledger.transitionPoller(triggerId, 'failed', { errorCode: 'deploy_no_side_effect' });
        return { action: 'no_side_effect_failure' };
      }
      return this.quarantine(triggerId, 'runtime_outcome_unverifiable');
    }
    if (observation.kind === 'mismatch') {
      if (!record.previousGood) return this.quarantine(triggerId, 'rollback_target_missing');
      this.ledger.recordDeployment(triggerId, 'rollback_intent', { observation });
      return { action: 'rollback_once', previousSha: record.previousGood.candidate.sha };
    }
    return this.quarantine(triggerId, `runtime_${observation.kind}`);
  }

  async complete(triggerId) {
    const record = this.ledger.getState().deployments[triggerId];
    if (record?.state !== 'deploy_intent') throw stateError('deployment_transition_invalid');
    const observation = await this.inspector.observeCandidate(record.candidate, record.digest);
    if (observation.kind !== 'healthy') return this.quarantine(triggerId, 'completion_unverifiable');
    this.advanceSuccess(triggerId, observation);
    return { action: 'deploy_succeeded' };
  }

  markRollbackIntent(triggerId, reason) {
    const record = this.ledger.getState().deployments[triggerId];
    if (!['deploy_intent', 'runtime_present', 'health_verified'].includes(record?.state)) {
      throw stateError('rollback_already_claimed');
    }
    this.ledger.recordDeployment(triggerId, 'rollback_intent', { rollbackReason: reason });
    return { action: 'rollback_once' };
  }

  async completeRollback(triggerId) {
    const record = this.ledger.getState().deployments[triggerId];
    if (record?.state !== 'rollback_intent') throw stateError('rollback_not_claimed');
    if (record.previousGood && await this.inspector.previousIsExact(record.previousGood)) {
      this.ledger.recordDeployment(triggerId, 'rollback_verified');
      this.ledger.recordDeployment(triggerId, 'failed', { failure: 'rollback_verified' });
      this.ledger.transitionPoller(triggerId, 'failed', { errorCode: 'deploy_rolled_back' });
      return { action: 'rollback_verified' };
    }
    return this.quarantine(triggerId, 'rollback_unverifiable');
  }

  advanceSuccess(triggerId, observation) {
    const record = this.ledger.getState().deployments[triggerId];
    if (record.state === 'deploy_intent') {
      this.ledger.recordDeployment(triggerId, 'runtime_present', { observation });
    }
    if (this.ledger.getState().deployments[triggerId].state === 'runtime_present') {
      this.ledger.recordDeployment(triggerId, 'health_verified');
    }
    this.ledger.recordDeployment(triggerId, 'deploy_succeeded');
    this.ledger.transitionPoller(triggerId, 'succeeded', { digest: record.digest });
  }

  quarantine(triggerId, reason) {
    const record = this.ledger.getState().deployments[triggerId];
    if (!['failed', 'deploy_succeeded', 'quarantined'].includes(record?.state)) {
      this.ledger.recordDeployment(triggerId, 'quarantined', { quarantineReason: reason });
    }
    const poller = this.ledger.getState().poller[triggerId];
    if (poller && !['failed', 'succeeded', 'quarantined'].includes(poller.state)) {
      this.ledger.transitionPoller(triggerId, 'quarantined', { errorCode: reason });
    }
    return { action: 'quarantined', reason };
  }
}

async function main() {
  if (!['begin', 'complete', 'rollback-intent', 'rollback-complete', 'reconcile'].includes(process.argv[2])) {
    throw new Error('usage: deployment-state.mjs COMMAND STATE_DIR RUNTIME_ROOT [identity...]');
  }
  if (process.env.CD_TRIGGER_MODE !== 'poller') throw stateError('trigger_mode_rejected');
  const [command, stateDir, runtimeRoot, ...args] = process.argv.slice(2);
  const coordinator = new DeploymentCoordinator({
    ledger: new SecureLedger(stateDir),
    inspector: new DockerRuntimeInspector(runtimeRoot),
  });
  let result;
  if (command === 'begin') {
    const [sha, runId, runAttempt, digest] = args;
    result = await coordinator.begin({ sha, runId, runAttempt }, digest);
  } else {
    const [triggerId, reason] = args;
    if (!/^[0-9a-f]{40}:[1-9][0-9]*:[1-9][0-9]*$/.test(triggerId ?? '')) {
      throw stateError('trigger_id_invalid');
    }
    if (command === 'complete') result = await coordinator.complete(triggerId);
    if (command === 'reconcile') result = await coordinator.reconcile(triggerId);
    if (command === 'rollback-intent') result = coordinator.markRollbackIntent(triggerId, reason ?? 'deployment_failed');
    if (command === 'rollback-complete') result = await coordinator.completeRollback(triggerId);
  }
  process.stdout.write(`${[result.action, result.previousSha].filter(Boolean).join('\t')}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
